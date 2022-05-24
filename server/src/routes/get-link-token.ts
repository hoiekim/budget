import { RequestHandler } from "express";
import { Route } from "routes";
import { getLinkToken, Handler, HandlerCallback } from "lib";

const getResponse: HandlerCallback = async () => {
  const response = await getLinkToken();
  if (!response) {
    console.error("[getLinkToken] has failed");
    return {
      status: "error",
      info: "Server failed to get link token",
    };
  }
  return {
    status: "success",
    data: response.link_token,
  };
};

const path = "/link-token";
const handler: RequestHandler = new Handler("GET", getResponse).handler;

const getLinkTokenRoute: Route = { path, handler };

export default getLinkTokenRoute;
