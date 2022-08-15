import { Route, MaskedUser, version } from "server";

export interface LoginGetResponse {
  user?: MaskedUser;
  app: { version: string };
}

export const getLoginRoute = new Route<LoginGetResponse>("GET", "/login", async (req) => {
  const { user } = req.session;
  return {
    status: "success",
    data: { user, app: { version } },
    info: user ? undefined : "Not logged in.",
  };
});
