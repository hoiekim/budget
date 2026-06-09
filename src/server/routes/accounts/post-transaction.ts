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

      // Kick off the previous-label read in parallel with the update.
      // Both run on separate pool connections; the rejection mirror
      // doesn't add to the API latency path.
      const reqLabel = transaction.label;
      const willTouchCategory = !!reqLabel && "category_id" in reqLabel;
      const prevLabelPromise =
        willTouchCategory && transaction.transaction_id
          ? getPrevLabel(user, transaction.transaction_id)
          : null;

      const response = await updateTransactions(user, [transaction]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const transaction_id = result.update._id || "";

      // Fire-and-forget the rejected_categories mirror. The API response
      // is agnostic to the mirror's success/failure — per Hoie 2026-06-09,
      // keep the mirror off the latency path. Any error logs to warn.
      if (willTouchCategory && prevLabelPromise && transaction_id) {
        const txIdForMirror = transaction_id;
        prevLabelPromise
          .then((prevLabel) =>
            recordCategoryRejection(user, txIdForMirror, reqLabel, prevLabel),
          )
          .catch((mirrorErr) =>
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
