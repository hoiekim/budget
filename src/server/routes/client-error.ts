import { Route } from "server/lib/route";
import { sendAlarm } from "server/lib/alarm";
import { logger } from "server/lib/logger";
import { createRateLimiter } from "server/lib/rate-limit";

export type ClientErrorPostBody = {
  message?: string;
  stack?: string;
  url?: string;
};

// Reports are driven by a browser loop the server does not control, so the cap
// bounds how much logging and Discord fan-out one client can buy. A page that
// throws on every render burns its quota and goes quiet; a user hitting a
// handful of distinct errors never reaches it.
const clientErrorRateLimiter = createRateLimiter("client-error", {
  maxAttempts: 20,
  windowMs: 15 * 60 * 1000,
});

/**
 * POST /client-error
 *
 * Accepts frontend error reports sent via navigator.sendBeacon and forwards
 * them to the Discord alarm. Session-gated like every other route (it is absent
 * from `PUBLIC_PATH_METHODS` in start.ts), so errors thrown before login are
 * rejected with 401 and never reported. Rate-limited per IP on top of that.
 */
export const postClientErrorRoute = new Route("POST", "/client-error", async (req, res) => {
  if (clientErrorRateLimiter.isLimited(req.ip)) {
    res.status(429);
    return {
      status: "failed" as const,
      message: "Too many client error reports, try again later",
    };
  }
  // Unlike the login limiter, which charges only failed auth, every accepted
  // report costs a slot — the cap is on volume, not on a failure outcome.
  clientErrorRateLimiter.consume(req.ip);

  const body = req.body as ClientErrorPostBody;

  const message = typeof body.message === "string" ? body.message : "(no message)";
  const stack = typeof body.stack === "string" ? body.stack : "";
  const url = typeof body.url === "string" ? body.url : "";

  logger.error("Client error reported", { url, message });

  const detail = [
    url ? `**URL:** ${url}` : null,
    `**Message:** ${message}`,
    stack ? `\`\`\`\n${stack.slice(0, 1000)}\n\`\`\`` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Dedicated cooldown bucket so client report volume, which any session can
  // drive, is charged here instead of to the server-side alarm sources.
  await sendAlarm("Client JS Error", detail, "client-error");

  return { status: "success" as const };
});
