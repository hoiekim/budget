import { ItemProvider } from "common";
import {
  Route,
  createManualTransaction,
  getAccount,
  getItem,
  requireQueryString,
  validationError,
} from "server";

export type NewTransactionGetResponse = { transaction_id: string; name: string };

/**
 * Mint a shell manual `transactions` row on a manual-account. The FE
 * navigates the user to the transaction detail page for the returned
 * id; the page's save-on-blur handlers fill in the fields. Gated to
 * `items.provider === MANUAL` so we don't accidentally create a
 * duplicate row on a Plaid-synced account (#567 acceptance criteria).
 */
export const getNewTransactionRoute = new Route<NewTransactionGetResponse>(
  "GET",
  "/new-transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const accountResult = requireQueryString(req, "account_id");
    if (!accountResult.success) return validationError(accountResult.error!);
    const account_id = accountResult.data!;

    const account = await getAccount(user, account_id);
    if (!account) return { status: "failed", message: "Account not found." };

    const item = await getItem(user, account.item_id);
    if (!item) return { status: "failed", message: "Item not found." };
    if (item.provider !== ItemProvider.MANUAL) {
      return {
        status: "failed",
        message: "Manual transaction entry is only allowed on manual accounts.",
      };
    }

    const created = await createManualTransaction(user, {
      account_id,
      iso_currency_code: account.balances.iso_currency_code,
    });
    if (!created) return { status: "failed", message: "Failed to create transaction." };

    return {
      status: "success",
      body: { transaction_id: created.transaction_id, name: created.name },
    };
  },
);
