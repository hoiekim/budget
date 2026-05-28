import {
  Route,
  updateSplitTransactions,
  requireBodyObject,
  requireStringField,
  validationError,
  inferLabelConfidence,
} from "server";
import type { PartialSplitTransaction } from "server";
import { logger } from "server/lib/logger";

export interface SplitTransactionPostResponse {
  split_transaction_id: string;
}

export const postSplitTransactionRoute = new Route<SplitTransactionPostResponse>(
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
      const split = inferLabelConfidence(body as PartialSplitTransaction);
      const response = await updateSplitTransactions(user, [split]);
      const split_transaction_id = response[0].update?._id || "";
      return { status: "success", body: { split_transaction_id } };
    } catch (error: unknown) {
      logger.error("Failed to update split transaction", { splitTransactionId: idResult.data }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
