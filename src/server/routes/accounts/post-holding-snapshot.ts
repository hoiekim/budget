import { getSquashedDateString, LocalDate, getRandomId, JSONHolding } from "common";
import {
  Route,
  requireBodyObject,
  validationError,
  upsertHoldingSnapshots,
  upsertHoldings,
  searchSecurities,
  upsertSecurities,
  polygon,
} from "server";
import { logger } from "server/lib/logger";
import { HoldingSnapshot } from "server/lib/postgres/repositories/snapshots";

export interface HoldingSnapshotPostResponse {
  snapshot_id: string;
  security_id: string;
}

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

    // Required fields
    const account_id = body.account_id as string | undefined;
    const ticker_symbol = body.ticker_symbol as string | undefined;
    const quantity = body.quantity as number | undefined;
    const snapshot_date = body.snapshot_date as string | undefined;

    if (!account_id) return validationError("account_id is required");
    if (!ticker_symbol) return validationError("ticker_symbol is required");
    if (quantity === undefined || quantity === null) return validationError("quantity is required");

    // Optional fields
    const cost_basis = body.cost_basis as number | undefined;
    const institution_price = body.institution_price as number | undefined;
    const institution_value = body.institution_value as number | undefined;

    // Resolve snapshot date (defaults to today)
    const date: Date = snapshot_date ? new LocalDate(snapshot_date) : new Date();
    const dateString = getSquashedDateString(date);

    // Look up or create security by ticker symbol
    const securities = await searchSecurities({ ticker_symbol: ticker_symbol.toUpperCase() });
    let security_id: string;

    if (securities.length > 0) {
      security_id = securities[0].security_id;
    } else {
      // Validate ticker and fetch security data from Polygon
      const securityData = await polygon.getSecurityForSymbol(ticker_symbol.toUpperCase(), date);
      if (!securityData) {
        return {
          status: "failed",
          message: `Ticker symbol "${ticker_symbol}" could not be validated. Please check the symbol and try again.`,
        };
      }
      await upsertSecurities([securityData]);
      security_id = securityData.security_id;
    }

    // Use deterministic snapshot ID so upsert on same account+security+date updates in place
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

      // Sync to current holdings so portfolio value reflects latest snapshot.
      // The holdings table stores current (most-recent) positions for each account/security pair.
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
