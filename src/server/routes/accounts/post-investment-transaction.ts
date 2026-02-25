import { Route, updateInvestmentTransactions, requireBodyObject, validationError } from "server";
import { logger } from "server/lib/logger";

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

    const body = bodyResult.data;

    try {
      const response = await updateInvestmentTransactions(user, [body as any]);
      const result = response[0];
      if (!result || result.status >= 400) {
        throw new Error("Database responded with an error.");
      }
      const investment_transaction_id = result.update._id || "";
      return { status: "success", body: { investment_transaction_id } };
    } catch (error: any) {
      logger.error("Failed to update investment transaction", { investmentTransactionId: (body as any).investment_transaction_id }, error);
      throw new Error(error);
    }
  },
);
