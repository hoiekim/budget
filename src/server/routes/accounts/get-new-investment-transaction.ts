import { AccountType } from "plaid";
import {
  Route,
  createManualInvestmentTransaction,
  getAccount,
  getSecurity,
  requireQueryString,
  validationError,
} from "server";

export type NewInvestmentTransactionGetResponse = {
  investment_transaction_id: string;
  name: string;
};

/**
 * Mint a shell manual `investment_transactions` row. Unlike
 * `getNewTransactionRoute`, this is NOT gated on
 * `items.provider === MANUAL` — #585's motivating case (RSU/ESPP
 * grants that predate Plaid's 24-month window) lives on a
 * Plaid-connected brokerage account. Plaid sync inserts/updates rows
 * keyed by its own IDs; the `manual-<uuid>` prefix here has no
 * collision surface, and `source='manual'` keeps the intent auditable.
 */
export const getNewInvestmentTransactionRoute =
  new Route<NewInvestmentTransactionGetResponse>(
    "GET",
    "/new-investment-transaction",
    async (req) => {
      const { user } = req.session;
      if (!user) return { status: "failed", message: "Request user is not authenticated." };

      const accountResult = requireQueryString(req, "account_id");
      if (!accountResult.success) return validationError(accountResult.error!);
      const account_id = accountResult.data!;

      const account = await getAccount(user, account_id);
      if (!account) return { status: "failed", message: "Account not found." };
      // Match the FE gate: the `+ Add Investment Transaction` button
      // only renders on investment accounts. Enforce the same server-side
      // so a direct-URL caller can't mint an investment_transactions row
      // against a depository/credit account (the row wouldn't render as a
      // holding, but the data is still wrong).
      if (account.type !== AccountType.Investment) {
        return {
          status: "failed",
          message: "Investment transactions can only be created on investment accounts.",
        };
      }

      // `security_id` is optional — omitted when the user clicks the
      // account-level `+ Add Investment Transaction` button and picks
      // the security in the detail form (via ticker-lookup). Prefilled
      // when the user clicks the per-security `+` on the holding detail
      // page. When present, validate it resolves to a real security —
      // without this, a caller could pass a garbage string that
      // silently inserts and later breaks `data.securities.get()`
      // lookups on the FE (there's no FK on the column).
      const security_id_raw = req.query?.security_id
        ? String(req.query.security_id)
        : null;
      let security_id: string | null = null;
      if (security_id_raw) {
        const security = await getSecurity(security_id_raw);
        if (!security) {
          return { status: "failed", message: "Security not found." };
        }
        security_id = security_id_raw;
      }

      // Holding-derived defaults from the caller. The FE prefills
      // `price` with the security's latest `institution_price` and
      // `iso_currency_code` with the holding's currency, so the
      // shell starts with values the user can confirm/correct rather
      // than a 0 that quietly zeroes the MWR calc if abandoned.
      const priceRaw = req.query?.price ? Number(req.query.price) : NaN;
      const price = Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : undefined;
      const iso_currency_code = req.query?.iso_currency_code
        ? String(req.query.iso_currency_code)
        : undefined;

      const created = await createManualInvestmentTransaction(user, {
        account_id,
        security_id,
        price,
        iso_currency_code,
      });
      if (!created) {
        return { status: "failed", message: "Failed to create investment transaction." };
      }

      return {
        status: "success",
        body: {
          investment_transaction_id: created.investment_transaction_id,
          name: created.name,
        },
      };
    },
  );
