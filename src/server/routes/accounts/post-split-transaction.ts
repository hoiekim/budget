import { Route, updateSplitTransactions, requireBodyObject, requireStringField, validationError } from "server";
import type { PartialSplitTransaction } from "server";

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

    const body = bodyResult.data as Record<string, unknown>;

    const idResult = requireStringField(body, "split_transaction_id");
    if (!idResult.success) return validationError(idResult.error!);

    try {
      const response = await updateSplitTransactions(user, [body as PartialSplitTransaction]);
      const split_transaction_id = response[0].update?._id || "";
      return { status: "success", body: { split_transaction_id } };
    } catch (error: unknown) {
      console.error(`Failed to update a split transaction: ${idResult.data}`);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
