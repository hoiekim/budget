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

      // Capture the previous label BEFORE the update so the rejection
      // mirror can name the category being cleared AND tell a real
      // budget switch from a body that re-states the current budget_id.
      // Skipped when the request body doesn't touch label.category_id —
      // a budget-only or memo-only update needs no rejection mirror.
      //
      // Read failure does NOT bubble out — the legacy update has not yet
      // run, but the mirror is best-effort and a transient pool blip
      // shouldn't fail the user's label change. Default to a null prev
      // label and let the helper's normal "prev was null → nothing to
      // reject" branch handle it.
      const reqLabel = transaction.label;
      const willTouchCategory = !!reqLabel && "category_id" in reqLabel;
      let prevLabel: PrevLabel = { category_id: null, budget_id: null };
      if (willTouchCategory && transaction.transaction_id) {
        try {
          prevLabel = await getPrevLabel(user, transaction.transaction_id);
        } catch (readErr) {
          logger.warn(
            "Failed to read previous label for rejection mirror — proceeding with null prev",
            { transactionId: transaction.transaction_id },
            readErr,
          );
        }
      }

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
          await recordCategoryRejection(user, transaction_id, reqLabel, prevLabel);
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
