import { Route, updateInvestmentTransactions, requireBodyObject, requireStringField, validationError } from "server";
import type { PartialInvestmentTransaction } from "server";

export interface InvestmentTransactionPostResponse {
  investment_transaction_id: string;
}

export const postInvestmentTrasactionRoute = new Route<InvestmentTransactionPostResponse>(
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

    try {
      const response = await updateInvestmentTransactions(user, [body as PartialInvestmentTransaction]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const investment_transaction_id = result.update._id || "";
      return { status: "success", body: { investment_transaction_id } };
    } catch (error: unknown) {
      console.error(
        `Failed to update an investment transaction: ${idResult.data}`,
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
