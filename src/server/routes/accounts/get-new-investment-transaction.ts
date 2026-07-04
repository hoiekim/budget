import {
  Route,
  createManualInvestmentTransaction,
  getAccount,
  getSecurity,
  requireQueryString,
  validationError,
} from "server";

export type NewInvestmentTransactionGetResponse = { investment_transaction_id: string };

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

      const created = await createManualInvestmentTransaction(user, {
        account_id,
        security_id,
      });
      if (!created) {
        return { status: "failed", message: "Failed to create investment transaction." };
      }

      return {
        status: "success",
        body: { investment_transaction_id: created.investment_transaction_id },
      };
    },
  );
