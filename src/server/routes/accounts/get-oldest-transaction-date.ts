import { getOldestTransactionDate, Route } from "server";

export type OldestTransactionDateGetResponse = string;

export const getOldestTransactionDateRoute = new Route<OldestTransactionDateGetResponse>(
  "GET",
  "/oldest-transaction-date",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const response = await getOldestTransactionDate(user);

    return {
      status: "success",
      body: response || new Date().toISOString().split('T')[0],
    };
  }
);
