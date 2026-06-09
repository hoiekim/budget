import {
  Route,
  updateTransactions,
  requireBodyObject,
  requireStringField,
  validationError,
  inferLabelConfidence,
  recordCategoryRejection,
  getPrevLabel,
} from "server";
import type { PartialTransaction, PrevLabel } from "server";
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

      // Read the previous label BEFORE the update. The update would
      // overwrite the columns we need to see (category_id, budget_id,
      // category_confidence) so running this read in parallel races
      // against the write — the mirror could see post-update state and
      // mis-classify the rejection.
      const reqLabel = transaction.label;
      const willTouchCategory = !!reqLabel && "category_id" in reqLabel;
      const prevLabel: PrevLabel | null =
        willTouchCategory && transaction.transaction_id
          ? await getPrevLabel(user, transaction.transaction_id)
          : null;

      const response = await updateTransactions(user, [transaction]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const transaction_id = result.update._id || "";

      // Fire-and-forget the rejected_categories mirror. The API response
      // shape doesn't depend on the mirror's success/failure, so keep
      // it off the latency path.
      if (willTouchCategory && prevLabel && transaction_id) {
        const txIdForMirror = transaction_id;
        recordCategoryRejection(user, txIdForMirror, reqLabel, prevLabel).catch(
          (mirrorErr) =>
            logger.warn(
              "Failed to mirror category change into rejected_categories",
              { transactionId: txIdForMirror },
              mirrorErr,
            ),
        );
      }

      return { status: "success", body: { transaction_id } };
    } catch (error: unknown) {
      logger.error("Failed to update transaction", { transactionId: txIdResult.data }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
