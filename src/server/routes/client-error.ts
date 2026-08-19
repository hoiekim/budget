import { Route } from "server/lib/route";
import { sendAlarm } from "server/lib/alarm";
import { logger } from "server/lib/logger";
import { clientErrorRateLimiter } from "server/lib/rate-limit";

export type ClientErrorPostBody = {
  message?: string;
  stack?: string;
  url?: string;
};

/**
 * POST /client-error
 *
 * Accepts frontend error reports sent via navigator.sendBeacon and forwards
 * them to the Discord alarm. Session-gated like every other route (it is absent
 * from `PUBLIC_PATH_METHODS` in start.ts), so errors thrown before login are
 * rejected with 401 and never reported. Rate-limited per IP on top of that.
 */
export const postClientErrorRoute = new Route("POST", "/client-error", async (req) => {
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
