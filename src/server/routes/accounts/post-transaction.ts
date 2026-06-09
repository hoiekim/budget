import {
  Route,
  updateTransactions,
  requireBodyObject,
  requireStringField,
  validationError,
  inferLabelConfidence,
  recordCategoryRejection,
  getPrevLabelCategoryId,
} from "server";
import type { PartialTransaction } from "server";
import { logger } from "server/lib/logger";

export interface TransactionPostResponse {
  transaction_id: string;
}

export const postTransactionRoute = new Route<TransactionPostResponse>(
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
      const transaction = inferLabelConfidence(bodyResult.data! as PartialTransaction);

      // Capture the previous label.category_id BEFORE the update so a
      // subsequent rejection write knows which category was cleared.
      // Skipped when the request body doesn't touch label.category_id —
      // a budget-only or memo-only update needs no rejection mirror.
      const reqLabel = transaction.label;
      const willTouchCategory = !!reqLabel && "category_id" in reqLabel;
      const prevCategoryId =
        willTouchCategory && transaction.transaction_id
          ? await getPrevLabelCategoryId(user, transaction.transaction_id)
          : null;

      const response = await updateTransactions(user, [transaction]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const transaction_id = result.update._id || "";

      // Mirror the label update into the rejected_categories event log.
      // Errors here do NOT bubble — the legacy label update already
      // succeeded; failure to mirror is a downgraded signal, not a
      // route failure.
      if (willTouchCategory) {
        try {
          await recordCategoryRejection(user, transaction_id, reqLabel, prevCategoryId);
        } catch (mirrorErr) {
          logger.warn(
            "Failed to mirror category change into rejected_categories",
            { transactionId: transaction_id },
            mirrorErr,
          );
        }
      }

      return { status: "success", body: { transaction_id } };
    } catch (error: unknown) {
      logger.error("Failed to update transaction", { transactionId: txIdResult.data }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
