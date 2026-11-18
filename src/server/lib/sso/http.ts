import { SSO_ERROR_PARAM, type SsoError } from "common";
import type { ApiResponse, ServerRequest, ServerResponse } from "server/lib/route";
import { responseSecurityHeaders } from "server/lib/security-headers";

/**
 * Deletes the vendored client's login cookie. The client hands back a
 * `clearCookie` only for a sign-in that succeeds; this is the same cookie,
 * for the ones that don't.
 */
export const CLEAR_LOGIN_COOKIE = "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

export const redirectResponse = (location: string, cookies: string[]): Response => {
  const headers = new Headers(responseSecurityHeaders());
  headers.set("Location", location);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/** Back to the sign-in page, saying why single sign-on did not complete. */
export const signInPageRedirect = (error: SsoError, clearLoginCookie = CLEAR_LOGIN_COOKIE): Response =>
  redirectResponse(`/login?${SSO_ERROR_PARAM}=${error}`, [clearLoginCookie]);

/** The request as the vendored client reads it: its URL and its cookies. */
export const toFetchRequest = (req: ServerRequest): Request => {
  const { cookie } = req.headers;
  return new Request(req.url, { headers: typeof cookie === "string" ? { cookie } : {} });
};

/** What `start.ts` answers for a path no route serves, for the routes that exist only while single sign-on is on. */
export const unknownRoute = (res: ServerResponse): ApiResponse => {
  res.status(404);
  return { status: "error", message: "Not Found" };
};
