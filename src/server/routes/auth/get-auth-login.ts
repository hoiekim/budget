import { SsoError } from "common";
import { Route, optionalQueryString } from "server";
import { Unavailable } from "server/lib/auth-client";
import {
  AUTH_LOGIN_PATH,
  getSso,
  redirectResponse,
  signInPageRedirect,
  toFetchRequest,
  unknownRoute,
} from "server/lib/sso";

export const getAuthLoginRoute = new Route("GET", AUTH_LOGIN_PATH, async (req, res) => {
  const sso = getSso();
  if (!sso) return unknownRoute(res);

  const returnTo = optionalQueryString(req, "returnTo");
  try {
    const { redirectUrl, loginCookie } = await sso.client.startLogin(toFetchRequest(req), {
      returnTo: returnTo.success ? returnTo.data : undefined,
    });
    return redirectResponse(redirectUrl, [loginCookie]);
  } catch (error) {
    if (error instanceof Unavailable) return signInPageRedirect(SsoError.Unavailable);
    throw error;
  }
});
