import { SsoError } from "common";
import { Route, isProduction, logger } from "server";
import {
  InvalidGrant,
  InvalidToken,
  LoginError,
  Unavailable,
  type Login,
} from "server/lib/auth-client";
import {
  SESSION_MAX_AGE_S,
  SSO_RECHECK_INTERVAL_MS,
  buildSessionCookie,
  buildSessionData,
  sessionStore,
} from "server/lib/session";
import {
  AUTH_CALLBACK_PATH,
  findOrCreateSsoUser,
  getSso,
  redirectResponse,
  signInPageRedirect,
  toFetchRequest,
  unknownRoute,
} from "server/lib/sso";

/** Why a sign-in the client refused failed, as the sign-in page shows it; `undefined` for an error that isn't a refusal. */
const refusalOf = (error: unknown): SsoError | undefined => {
  if (error instanceof Unavailable) return SsoError.Unavailable;
  if (error instanceof LoginError) {
    if (error.code === "authorization_error" && error.error === "access_denied") {
      return SsoError.NoAccess;
    }
    if (error.code === "authorization_error" || error.code === "missing_code") return SsoError.Failed;
    return SsoError.Expired;
  }
  if (error instanceof InvalidToken || error instanceof InvalidGrant) return SsoError.Failed;
  return undefined;
};

export const getAuthCallbackRoute = new Route("GET", AUTH_CALLBACK_PATH, async (req, res) => {
  const sso = getSso();
  if (!sso) return unknownRoute(res);

  let login: Login;
  try {
    login = await sso.client.finishLogin(toFetchRequest(req));
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === undefined) throw error;
    logger.warn("Single sign-on did not complete", { component: "sso", refusal }, error);
    return signInPageRedirect(refusal);
  }

  // Budget has no roles of its own: any role is access.
  if (!login.claims.role) return signInPageRedirect(SsoError.NoAccess, login.clearCookie);

  const found = await findOrCreateSsoUser(login.claims, sso.config.linkUsers);
  if ("error" in found) {
    logger.warn("Single sign-on refused", { component: "sso", refusal: found.error });
    return signInPageRedirect(found.error, login.clearCookie);
  }

  await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
  const secure = isProduction();
  await sessionStore().set(
    req.session.id,
    buildSessionData(found.user, secure, {
      sid: login.claims.sid,
      refreshToken: login.refreshToken ?? null,
      recheckAt: new Date(Date.now() + SSO_RECHECK_INTERVAL_MS),
    }),
  );
  return redirectResponse(login.returnTo, [
    login.clearCookie,
    buildSessionCookie(req.session.id, SESSION_MAX_AGE_S, secure),
  ]);
});
