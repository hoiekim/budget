import { Route } from "server";
import { logger } from "server/lib/logger";
import { getSso } from "server/lib/sso";

export interface LoginDeleteResponse {
  /** For a single sign-on session: where the browser goes to sign out of the identity provider too. */
  logoutUrl?: string;
}

export const deleteLoginRoute = new Route<LoginDeleteResponse>("DELETE", "/login", async (req) => {
  const { auth } = req.session;
  await req.session.destroy();

  const sso = getSso();
  if (!auth || !sso) return { status: "success" };

  if (auth.refreshToken !== null) {
    sso.client.revoke(auth.refreshToken).catch((error) => {
      logger.warn("Failed to revoke the single sign-on refresh token", { component: "sso" }, error);
    });
  }
  const logoutUrl = await sso.client
    .logoutUrl(sso.config.postLogoutRedirect)
    .catch((error) => {
      logger.warn("Failed to build the single sign-on logout URL", { component: "sso" }, error);
      return undefined;
    });
  return { status: "success", body: logoutUrl ? { logoutUrl } : undefined };
});
