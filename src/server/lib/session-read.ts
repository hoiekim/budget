import { logger } from "server/lib/logger";
import { sendAlarm } from "server/lib/alarm";
import type { SessionData } from "server/lib/postgres/models/session";
import type { PostgresSessionStore } from "server/lib/postgres/repositories/session";

/**
 * Read one session row, degrading to null on a store fault — but no longer
 * silently. A Postgres fault during session lookup used to present as a
 * mass silent logout with zero observability into the actual cause. The
 * fault is logged at error level and alarmed under the
 * `session_store_read_fault` key, so a brownout shows up in monitoring
 * instead of masquerading as user logouts. The caller still falls back to
 * an anonymous session, as before.
 *
 * There is no metrics-counter system in the server, so the alarm key is
 * the countable signal: `sendAlarm` cools down per key (one alarm a
 * minute), so a brownout alarms once a minute instead of once a request,
 * while every fault still lands in the error log.
 *
 * The session id is never logged or alarmed: it is a bearer-equivalent
 * credential, and the fault carries no per-session information anyway.
 */
export const readSessionData = async (
  store: Pick<PostgresSessionStore, "get">,
  sid: string,
): Promise<SessionData | null> => {
  try {
    return await store.get(sid);
  } catch (error) {
    logger.error("Session store read fault", { component: "sessions" }, error);
    sendAlarm(
      "Session Store Read Fault",
      `**Error:** ${error instanceof Error ? error.message : String(error)}`,
      "session_store_read_fault",
    ).catch(() => undefined);
    return null;
  }
};
