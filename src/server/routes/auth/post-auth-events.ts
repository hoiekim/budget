import { Route } from "server";
import { InvalidToken, Unavailable, type AuthEvent } from "server/lib/auth-client";
import { AUTH_EVENTS_PATH, getSso, handleAuthEvent, unknownRoute } from "server/lib/sso";

/**
 * The identity provider's security events. Public, with no session or origin
 * check: a token that does not verify against the provider's keys is
 * refused, and a 5xx makes the provider deliver it again.
 */
export const postAuthEventsRoute = new Route("POST", AUTH_EVENTS_PATH, async (req, res) => {
  const sso = getSso();
  if (!sso) return unknownRoute(res);

  let event: AuthEvent;
  try {
    event = await sso.client.readEvent(req.rawBody ?? "");
  } catch (error) {
    if (error instanceof InvalidToken) {
      res.status(400);
      return { status: "failed", message: "Invalid security event token." };
    }
    if (error instanceof Unavailable) {
      res.status(503);
      return { status: "failed", message: "Cannot verify the security event token yet." };
    }
    throw error;
  }

  await handleAuthEvent(event);
  res.status(202);
  return { status: "success" };
});
