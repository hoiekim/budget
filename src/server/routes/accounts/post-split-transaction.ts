import {
  Route,
  updateSplitTransactions,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
  inferLabelConfidence,
} from "server";
import type { FieldSpec, PartialSplitTransaction } from "server";
import { logger } from "server/lib/logger";

/**
 * Typed fields `SplitTransactionModel.fromJSON` copies into a row
 * (`models/split_transaction.ts`). `split_transaction_id` is the table's
 * `UUID PRIMARY KEY`, so a non-UUID reaches the `WHERE` clause and raises
 * `22P02`. The `label.*` fields accept explicit null — that is how the
 * client clears a label.
 */
const SPLIT_TRANSACTION_BODY_SPEC: FieldSpec[] = [
  { path: "split_transaction_id", type: "uuid" },
  { path: "transaction_id", type: "string" },
  { path: "amount", type: "number" },
  { path: "date", type: "date" },
  { path: "label.budget_id", type: "uuid", nullable: true },
  { path: "label.category_id", type: "uuid", nullable: true },
  { path: "label.category_confidence", type: "number", nullable: true },
];

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

    const fieldsResult = validateFields(body, SPLIT_TRANSACTION_BODY_SPEC);
    if (!fieldsResult.success) return validationError(fieldsResult.error!);

    try {
      const split = inferLabelConfidence(body as PartialSplitTransaction);
      const response = await updateSplitTransactions(user, [split]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const split_transaction_id = result.update._id || "";
      return { status: "success", body: { split_transaction_id } };
    } catch (error: unknown) {
      logger.error("Failed to update split transaction", { splitTransactionId: idResult.data }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
