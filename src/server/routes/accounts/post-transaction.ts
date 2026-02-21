import { Route, updateTransactions, requireBodyObject, requireStringField, validationError } from "server";
import type { PartialTransaction } from "server";

export interface TransactionPostResponse {
  transaction_id: string;
}

export const postTrasactionRoute = new Route<TransactionPostResponse>(
  "POST",
  "/transaction",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) {
      return validationError(bodyResult.error!);
    }
    
    // Validate required transaction_id field
    const txIdResult = requireStringField(bodyResult.data!, "transaction_id" as keyof object);
    if (!txIdResult.success) {
      return validationError(txIdResult.error!);
    }

    try {
      // Cast is safe after validation above
      const transaction = bodyResult.data! as PartialTransaction;
      const response = await updateTransactions(user, [transaction]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const transaction_id = result.update._id || "";
      return { status: "success", body: { transaction_id } };
    } catch (error: any) {
      console.error(`Failed to update a transaction: ${txIdResult.data}`);
      throw new Error(error);
    }
  },
);
