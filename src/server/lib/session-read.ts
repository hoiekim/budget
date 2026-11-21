import { logger } from "server/lib/logger";
import { sendAlarm } from "server/lib/alarm";
import type { SessionData } from "server/lib/postgres/models/session";
import type { PostgresSessionStore } from "server/lib/postgres/repositories/session";

const ISSUED_SID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read one session row, degrading to null when there is none.
 *
 * A sid that does not have the shape the server issues (`randomUUID()`) is
 * treated as "no session" without touching the store, so a garbage cookie
 * can never surface as a store fault.
 *
 * A store fault also degrades to null, and is logged at error level and
 * alarmed under the `session_store_read_fault` key. `sendAlarm` cools down
 * per key, so a brownout alarms once a minute while every fault still lands
 * in the error log.
 *
 * The session id is never logged or alarmed: it is a bearer-equivalent
 * credential.
 */
export const readSessionData = async (
  store: Pick<PostgresSessionStore, "get">,
  sid: string,
): Promise<SessionData | null> => {
  if (!ISSUED_SID_SHAPE.test(sid)) return null;
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
