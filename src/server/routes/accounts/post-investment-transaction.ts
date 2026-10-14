import {
  Route,
  updateInvestmentTransactions,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec, PartialInvestmentTransaction } from "server";
import { logger } from "server/lib/logger";

/**
 * Typed fields `InvTxModel.fromJSON` copies into a row
 * (`models/investment_transaction.ts`). `label.budget_id` and
 * `label.category_id` land in `UUID` columns on this table too, so they are
 * guarded even though the numeric trio is the headline; explicit null is how
 * the client clears a label.
 */
const INVESTMENT_TRANSACTION_BODY_SPEC: FieldSpec[] = [
  { path: "amount", type: "number" },
  { path: "quantity", type: "number" },
  { path: "price", type: "number" },
  { path: "date", type: "date" },
  { path: "label.budget_id", type: "uuid", nullable: true },
  { path: "label.category_id", type: "uuid", nullable: true },
];

export interface InvestmentTransactionPostResponse {
  investment_transaction_id: string;
}

export const postInvestmentTransactionRoute = new Route<InvestmentTransactionPostResponse>(
  "POST",
  "/investment-transaction",
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

    const idResult = requireStringField(body, "investment_transaction_id");
    if (!idResult.success) return validationError(idResult.error!);

    const fieldsResult = validateFields(body, INVESTMENT_TRANSACTION_BODY_SPEC);
    if (!fieldsResult.success) return validationError(fieldsResult.error!);

    try {
      const response = await updateInvestmentTransactions(user, [body as PartialInvestmentTransaction]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const investment_transaction_id = result.update._id || "";
      return { status: "success", body: { investment_transaction_id } };
    } catch (error: unknown) {
      logger.error("Failed to update investment transaction", { investmentTransactionId: idResult.data }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
