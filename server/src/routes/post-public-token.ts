import { RequestHandler } from "express";
import { Route } from "routes";
import { exchangePublicToken, Handler, HandlerCallback } from "lib";

const getResponse: HandlerCallback = async (req) => {
  const token = req.body.token;
  const response = await exchangePublicToken(token);
  if (!response) {
    console.error("[exchangePublicToken] has failed");
    return {
      status: "error",
      info: "Server failed to exchange token",
    };
  }
  return {
    status: "success",
  };
};

const path = "/public-token";
const handler: RequestHandler = new Handler("POST", getResponse).handler;

const getLinkTokenRoute: Route = { path, handler };

export default getLinkTokenRoute;
