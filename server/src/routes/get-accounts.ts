import { RequestHandler } from "express";
import { Route } from "routes";
import { getAccounts, Handler, HandlerCallback } from "lib";

const getResponse: HandlerCallback = async () => {
  const response = await getAccounts();
  if (!response) {
    console.error("[plaid.getAccounts] has failed");
    return {
      status: "error",
      info: "Server failed to get accounts",
    };
  }
  return {
    status: "success",
    data: response,
  };
};

const path = "/accounts";
const handler: RequestHandler = new Handler("GET", getResponse).handler;

const getTransactionsRoute: Route = { path, handler };

export default getTransactionsRoute;
