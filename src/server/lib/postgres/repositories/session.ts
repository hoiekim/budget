import { sessionsTable, SessionModel, SessionData, SESSION_ID, COOKIE_EXPIRES } from "../models";
import { logger } from "../../logger";

/**
 * Remove expired sessions from the database.
 * @returns The number of sessions purged
 */
export async function purgeSessions(): Promise<number> {
  return sessionsTable.deleteByCondition(COOKIE_EXPIRES, "<=", new Date());
}

export class PostgresSessionStore {
  private cleanupInterval: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.startCleanupScheduler();
  }

  private startCleanupScheduler(): void {
    // Run cleanup every hour
    const runCleanup = () => {
      purgeSessions()
        .then((count) => {
          if (count > 0) {
            logger.info(`Purged ${count} expired session(s)`, { component: "sessions" });
          }
        })
        .catch((error) => {
          logger.error("Session cleanup error", { component: "sessions" }, error);
        });
      this.cleanupInterval = setTimeout(runCleanup, 1000 * 60 * 60);
    };

    // Initial cleanup after 1 minute (give server time to start)
    this.cleanupInterval = setTimeout(runCleanup, 1000 * 60);
  }

  async get(sid: string): Promise<SessionData | null> {
    const model = await sessionsTable.queryOne({ [SESSION_ID]: sid });
    if (!model) return null;
    return model.toJSON();
  }

  async set(sid: string, session: SessionData): Promise<void> {
    const row = SessionModel.fromSessionData(sid, session);
    await sessionsTable.upsert(row, Object.keys(row).filter((k) => k !== SESSION_ID));
  }

  async destroy(sid: string): Promise<void> {
    await sessionsTable.hardDelete(sid);
  }

  async touch(sid: string, session: SessionData): Promise<void> {
    const row = SessionModel.fromSessionData(sid, session);
    const updateData = { ...row };
    delete (updateData as Record<string, unknown>)[SESSION_ID];
    await sessionsTable.update(sid, updateData);
  }
}
