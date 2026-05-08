import { getRandomId, getSquashedDateString, LocalDate, JSONHolding, JSONSecurity } from "common";
import {
  Route,
  requireBodyObject,
  validationError,
  upsertHoldingSnapshots,
  upsertHoldings,
  searchSecurities,
  upsertSecurities,
  getHoldingSnapshots,
  polygon,
} from "server";
import { logger } from "server/lib/logger";
import { HoldingSnapshot, snapshotsTable } from "server/lib/postgres/repositories";

export interface HoldingSnapshotPostResponse {
  snapshot_id: string;
  security_id: string;
}

/**
 * Resolve a ticker symbol to a security_id, creating the security via
 * Polygon's ticker-detail API if it does not yet exist locally. Price is
 * intentionally not required so future-dated snapshots do not falsely
 * reject valid tickers (matches the validate-ticker route's leniency).
 */
const resolveSecurityId = async (
  rawTicker: string,
): Promise<{ ok: true; security_id: string } | { ok: false; message: string }> => {
  const upperTicker = rawTicker.toUpperCase();
  const securities = await searchSecurities({ ticker_symbol: upperTicker });
  if (securities.length > 0) return { ok: true, security_id: securities[0].security_id };

  const detailResult = await polygon.getTickerDetail(upperTicker);
  if (!detailResult.success) {
    return {
      ok: false,
      message:
        detailResult.error === "no_api_key"
          ? "Market data API is not configured. Contact your administrator."
          : `Ticker symbol "${rawTicker}" could not be validated. Please check the symbol and try again.`,
    };
  }
  const { name, currency_name } = detailResult.data;
  const newSecurity: JSONSecurity = {
    security_id: getRandomId(),
    ticker_symbol: upperTicker,
    name,
    iso_currency_code: currency_name.toUpperCase(),
    close_price: null,
    close_price_as_of: null,
    isin: null,
    cusip: null,
    sedol: null,
    institution_security_id: null,
    institution_id: null,
    proxy_security_id: null,
    is_cash_equivalent: null,
    type: null,
    update_datetime: null,
    unofficial_currency_code: null,
    market_identifier_code: null,
    sector: null,
    industry: null,
    option_contract: null,
    fixed_income: null,
  };
  await upsertSecurities([newSecurity]);
  return { ok: true, security_id: newSecurity.security_id };
};

export const postHoldingSnapshotRoute = new Route<HoldingSnapshotPostResponse>(
  "POST",
  "/snapshots/holding",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);

    const body = bodyResult.data as Record<string, unknown>;
    const provided_snapshot_id = body.snapshot_id as string | undefined;

    // ── Update mode ─────────────────────────────────────────────────────────
    // When snapshot_id is present, treat the request as a partial update —
    // only the fields included in the body are written. Powers the on-blur
    // edit flow on the Holding Detail page.
    if (provided_snapshot_id) {
      const userSnapshots = await getHoldingSnapshots(user);
      const existing = userSnapshots.find((s) => s.snapshot_id === provided_snapshot_id);
      if (!existing) {
        return { status: "failed", message: "Snapshot not found or access denied." };
      }

      const patch: Record<string, unknown> = {};
      let new_security_id: string | undefined;

      if (typeof body.ticker_symbol === "string" && body.ticker_symbol.trim()) {
        const resolved = await resolveSecurityId(body.ticker_symbol.trim());
        if (!resolved.ok) return { status: "failed", message: resolved.message };
        new_security_id = resolved.security_id;
        patch.holding_security_id = new_security_id;
      }
      if (typeof body.snapshot_date === "string" && body.snapshot_date) {
        const d = new LocalDate(body.snapshot_date);
        patch.snapshot_date = d.toISOString().split("T")[0];
      }
      if (body.quantity !== undefined) patch.quantity = body.quantity;
      if (body.cost_basis !== undefined) patch.cost_basis = body.cost_basis;
      if (body.institution_price !== undefined) patch.institution_price = body.institution_price;
      if (body.institution_value !== undefined) patch.institution_value = body.institution_value;

      if (Object.keys(patch).length === 0) {
        return validationError("no fields to update");
      }

      try {
        await snapshotsTable.update(provided_snapshot_id, patch, undefined, user.user_id);

        // Re-sync the current-holdings row from the latest snapshot state so
        // portfolio value calculations stay consistent with the edit.
        const refreshed = (await getHoldingSnapshots(user)).find(
          (s) => s.snapshot_id === provided_snapshot_id,
        );
        if (refreshed) {
          const security_id = refreshed.holding_security_id;
          const holding: JSONHolding = {
            holding_id: `${refreshed.holding_account_id}-${security_id}`,
            account_id: refreshed.holding_account_id,
            security_id,
            quantity: refreshed.quantity ?? 0,
            cost_basis: refreshed.cost_basis ?? null,
            institution_price: refreshed.institution_price ?? 0,
            institution_price_as_of: refreshed.snapshot_date,
            institution_value:
              refreshed.institution_value ??
              (refreshed.quantity ?? 0) * (refreshed.institution_price ?? 0),
            iso_currency_code: null,
            unofficial_currency_code: null,
          };
          await upsertHoldings(user, [holding]);
        }

        return {
          status: "success",
          body: {
            snapshot_id: provided_snapshot_id,
            security_id: new_security_id ?? existing.holding_security_id,
          },
        };
      } catch (error: unknown) {
        logger.error(
          "Failed to update holding snapshot",
          { snapshot_id: provided_snapshot_id },
          error,
        );
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    // ── Create mode ─────────────────────────────────────────────────────────
    const account_id = body.account_id as string | undefined;
    const ticker_symbol = body.ticker_symbol as string | undefined;
    const quantity = body.quantity as number | undefined;
    const snapshot_date = body.snapshot_date as string | undefined;

    if (!account_id) return validationError("account_id is required");
    if (!ticker_symbol) return validationError("ticker_symbol is required");
    if (quantity === undefined || quantity === null) return validationError("quantity is required");

    const cost_basis = body.cost_basis as number | undefined;
    const institution_price = body.institution_price as number | undefined;
    const institution_value = body.institution_value as number | undefined;

    const date: Date = snapshot_date ? new LocalDate(snapshot_date) : new Date();
    const dateString = getSquashedDateString(date);

    const resolved = await resolveSecurityId(ticker_symbol);
    if (!resolved.ok) return { status: "failed", message: resolved.message };
    const security_id = resolved.security_id;

    // Deterministic snapshot ID so a duplicate (account, security, date) tuple
    // updates in place rather than producing duplicate rows.
    const snapshot_id = `holding-${account_id}-${security_id}-${dateString}`;

    const snapshot: HoldingSnapshot = {
      snapshot_id,
      snapshot_date: date.toISOString().split("T")[0],
      holding_account_id: account_id,
      holding_security_id: security_id,
      quantity,
      cost_basis,
      institution_price,
      institution_value,
    };

    try {
      await upsertHoldingSnapshots(user, [snapshot]);

      const holding: JSONHolding = {
        holding_id: `${account_id}-${security_id}`,
        account_id,
        security_id,
        quantity,
        cost_basis: cost_basis ?? null,
        institution_price: institution_price ?? 0,
        institution_price_as_of: date.toISOString(),
        institution_value: institution_value ?? quantity * (institution_price ?? 0),
        iso_currency_code: null,
        unofficial_currency_code: null,
      };
      await upsertHoldings(user, [holding]);

      return { status: "success", body: { snapshot_id, security_id } };
    } catch (error: unknown) {
      logger.error("Failed to upsert holding snapshot", { snapshot_id }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);

