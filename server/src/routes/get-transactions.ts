import { RequestHandler } from "express";
import { Route } from "routes";
import { getTransactions, Handler, HandlerCallback } from "lib";

const getResponse: HandlerCallback = async () => {
  const response = await getTransactions();
  if (!response) {
    console.error("[plaid.getTransactions] has failed");
    return {
      status: "error",
      info: "Server failed to get transactions",
    };
  }
  return {
    status: "success",
    data: response,
  };
};

const path = "/transactions";
const handler: RequestHandler = new Handler("GET", getResponse).handler;

const getTransactionsRoute: Route = { path, handler };

export default getTransactionsRoute;
