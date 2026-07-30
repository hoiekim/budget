import { Route } from "server/lib/route";
import { sendAlarm } from "server/lib/alarm";
import { logger } from "server/lib/logger";

export type ClientErrorPostBody = {
  message?: string;
  stack?: string;
  url?: string;
};

/**
 * POST /client-error
 *
 * Accepts frontend error reports sent via navigator.sendBeacon.
 * Forwards to Discord alarm. No auth required (beacon fires after page unload).
 */
export const postClientErrorRoute = new Route("POST", "/client-error", async (req) => {
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

  // Dedicated cooldown bucket: this endpoint is unauthenticated, so sharing a
  // bucket let any caller suppress unrelated server-side alarms indefinitely.
  await sendAlarm("Client JS Error", detail, "client-error");

  return { status: "success" as const };
});
