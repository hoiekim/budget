import {
  getDateString,
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

    const requestedDate = new Date(date);
    if (Number.isNaN(requestedDate.getTime())) {
      return validationError(`invalid date: ${date}`);
    }

    // Don't burn a Polygon call on future dates — the market hasn't
    // closed there yet. Cap the lookup at today.
    const today = new Date();
    const effectiveDate = requestedDate > today ? today : requestedDate;
    const effectiveDateStr = getDateString(effectiveDate);

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
      const nearestDate = getDateString(new Date(nearest.snapshot_date));
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
    const priceResult = await polygon.getLatestClosePriceOnOrBefore(ticker, effectiveDate);
    if (!priceResult.success) {
      return {
        status: "success",
        body: {
          resolved: false,
          message:
            priceResult.error === "no_api_key"
              ? "Market data API is not configured"
              : priceResult.error === "no_data"
                ? `No price data for ${ticker} on or before ${effectiveDateStr}`
                : `Polygon error: ${priceResult.message}`,
        },
      };
    }

    const { price, tradingDate } = priceResult.data;
    const snapshot: JSONSecuritySnapshot = {
      snapshot: {
        snapshot_id: `${security_id}-${getSquashedDateString(new Date(tradingDate))}`,
        date: new Date(tradingDate).toISOString(),
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
