import { RequestHandler } from "express";
import getLinkToken from "./get-link-token";
import postPublicToken from "./post-public-token";
import getTransaction from "./get-transactions";

export interface Route {
  path: string;
  handler: RequestHandler;
}

const routes: Route[] = [getLinkToken, postPublicToken, getTransaction];

export default routes;
