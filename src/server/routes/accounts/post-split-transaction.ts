import { Route, updateSplitTransactions, requireBodyObject, validationError } from "server";

export interface SplitTransactionPostResponse {
  split_transaction_id: string;
}

export const postSplitTrasactionRoute = new Route<SplitTransactionPostResponse>(
  "POST",
  "/split-transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);

    const body = bodyResult.data;

    try {
      const response = await updateSplitTransactions(user, [body as any]);
      const split_transaction_id = response[0].update?._id || "";
      return { status: "success", body: { split_transaction_id } };
    } catch (error: any) {
      console.error(`Failed to update a split transaction: ${(body as any).split_transaction_id}`);
      throw new Error(error);
    }
  },
);
