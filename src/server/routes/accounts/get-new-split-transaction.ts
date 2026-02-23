import { Route, createSplitTransaction, requireQueryString, validationError } from "server";

export type NewSplitTransactionGetResponse = { split_transaction_id: string };

export const getNewSplitTransactionRoute = new Route<NewSplitTransactionGetResponse>(
  "GET",
  "/new-split-transaction",
  async (req, _res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const transactionResult = requireQueryString(req, "transaction_id");
    if (!transactionResult.success) return validationError(transactionResult.error!);

    const accountResult = requireQueryString(req, "account_id");
    if (!accountResult.success) return validationError(accountResult.error!);
    
    const response = await createSplitTransaction(user, { 
      transaction_id: transactionResult.data!, 
      account_id: accountResult.data! 
    });
    if (!response) {
      return { status: "failed", message: "Failed to create split transaction." };
    }

    return { status: "success", body: { split_transaction_id: response.split_transaction_id } };
  }
);
