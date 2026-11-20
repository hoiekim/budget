import { Route, MaskedUser, version } from "server";
import { ssoMode, type SsoMode } from "server/lib/sso";

export interface LoginGetResponse {
  user?: MaskedUser;
  app: { version: string };
  sso: SsoMode;
}

export const getLoginRoute = new Route<LoginGetResponse>("GET", "/login", async (req) => {
  const { user } = req.session;
  return {
    status: "success",
    body: { user, app: { version }, sso: ssoMode() },
    message: user ? undefined : "Not logged in.",
  };
});
