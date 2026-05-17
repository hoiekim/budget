import {
  getSquashedDateString,
  JSONSecuritySnapshot,
} from "common";
import {
  Route,
  requireBodyObject,
  validationError,
  getSecurity,
  getSecuritySnapshots,
  upsertSnapshots,
  polygon,
  logger,
} from "server";

export interface ResolveSecuritySnapshotResponse {
  resolved: boolean;
  snapshot?: JSONSecuritySnapshot;
  source?: "existing" | "polygon";
  /** When resolved=false, the underlying polygon error category. */
  reason?: "no_api_key" | "api_error" | "no_data" | "plan_limit";
  message?: string;
}

const MAX_PROXIMITY_DAYS = 7;

const daysBetween = (a: string, b: string): number => {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
};

/**
 * POST /resolve-security-snapshot
 *
 * Resolve (and persist) a security snapshot at or before `date` for
 * `security_id`. If we already have a snapshot within 7 days at-or-before
 * the requested date, return that. Otherwise query Polygon for the
 * closest trading-day close in the 7-day window ending at `date`, upsert
 * the result, and return it.
 *
 * Powers the PerformanceBenchmark widget's on-demand benchmark price
 * fetch: when a user picks a 3Y window starting before our VOO snapshot
 * history, the widget calls this with `{ security_id: <VOO>, date:
 * windowStart }` and merges the returned snapshot into AppContext so the
 * benchmark TWR can be computed over the full window.
 */
export const postResolveSecuritySnapshotRoute = new Route<ResolveSecuritySnapshotResponse>(
  "POST",
  "/resolve-security-snapshot",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);
    const body = bodyResult.data as Record<string, unknown>;

    const security_id = body.security_id;
    const date = body.date;
    if (typeof security_id !== "string" || !security_id) {
      return validationError("security_id is required");
    }
    if (typeof date !== "string" || !date) {
      return validationError("date is required (YYYY-MM-DD)");
    }

    // Validate by checking the leading 10 chars match YYYY-MM-DD exactly,
    // then keep the input as a string for the rest of the route — we want
    // the date to round-trip through Polygon without local-timezone shifts.
    const datePrefix = date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePrefix)) {
      return validationError(`invalid date: ${date}`);
    }

    // Don't burn a Polygon call on future dates — the market hasn't
    // closed there yet. Cap the lookup at today (string compare is safe
    // for ISO YYYY-MM-DD).
    const todayStr = new Date().toISOString().slice(0, 10);
    const effectiveDateStr = datePrefix > todayStr ? todayStr : datePrefix;

    const security = await getSecurity(security_id);
    if (!security) {
      return { status: "success", body: { resolved: false, message: "security not found" } };
    }
    const ticker = security.ticker_symbol;
    if (!ticker || ticker.startsWith("CUR:") || security.type === "cash") {
      return {
        status: "success",
        body: { resolved: false, message: "security has no ticker / is cash-equivalent" },
      };
    }

    // If we already have a close-enough snapshot at-or-before the request,
    // skip the Polygon call. The 7-day tolerance matches the benchmark
    // widget's price-walk: latest snapshot ≤ date is the price we'd use
    // for TWR anyway.
    const existing = await getSecuritySnapshots({ security_id, endDate: effectiveDateStr });
    if (existing.length > 0) {
      const nearest = existing[existing.length - 1]; // sorted ASC by snapshot_date
      const nearestDate = nearest.snapshot_date.slice(0, 10);
      if (
        nearest.close_price != null &&
        daysBetween(nearestDate, effectiveDateStr) <= MAX_PROXIMITY_DAYS
      ) {
        const snapshot: JSONSecuritySnapshot = {
          snapshot: { snapshot_id: nearest.snapshot_id, date: nearest.snapshot_date },
          security: { ...security, close_price: nearest.close_price, close_price_as_of: nearestDate },
        };
        return {
          status: "success",
          body: { resolved: true, snapshot, source: "existing" },
        };
      }
    }

    // Polygon fetch
    const priceResult = await polygon.getLatestClosePriceOnOrBefore(ticker, effectiveDateStr);
    if (!priceResult.success) {
      const message =
        priceResult.error === "no_api_key"
          ? "Market data API is not configured"
          : priceResult.error === "plan_limit"
            ? `Polygon plan doesn't include this date range`
            : priceResult.error === "no_data"
              ? `No price data for ${ticker} on or before ${effectiveDateStr}`
              : `Polygon error: ${priceResult.message}`;
      return {
        status: "success",
        body: { resolved: false, reason: priceResult.error, message },
      };
    }

    const { price, tradingDate } = priceResult.data;
    // tradingDate is already a YYYY-MM-DD string from the polygon helper.
    // Use noon UTC for the snapshot.date timestamp so the date doesn't
    // shift back a day when read with local-tz getDate() somewhere.
    const snapshot: JSONSecuritySnapshot = {
      snapshot: {
        snapshot_id: `${security_id}-${getSquashedDateString(new Date(`${tradingDate}T12:00:00Z`))}`,
        date: `${tradingDate}T12:00:00.000Z`,
      },
      security: {
        ...security,
        close_price: price,
        close_price_as_of: tradingDate,
      },
    };

    try {
      await upsertSnapshots([snapshot]);
    } catch (error) {
      logger.error(
        "resolve-security-snapshot: upsert failed",
        { security_id, tradingDate },
        error,
      );
      // Non-fatal — still return the price so the client can use it
      // for the current render. Next call will retry the upsert.
    }

    return { status: "success", body: { resolved: true, snapshot, source: "polygon" } };
  },
);
