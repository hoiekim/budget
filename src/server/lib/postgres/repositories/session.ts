import { Store, SessionData as ExpressSessionData } from "express-session";
import { sessionsTable, SessionModel, SESSION_ID, COOKIE_EXPIRES } from "../models";

/**
 * Remove expired sessions from the database.
 * @returns The number of sessions purged
 */
export async function purgeSessions(): Promise<number> {
  return sessionsTable.deleteByCondition(COOKIE_EXPIRES, "<=", new Date());
}

export class PostgresSessionStore extends Store {
  private cleanupInterval: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.startCleanupScheduler();
  }

  private startCleanupScheduler(): void {
    // Run cleanup every hour
    const runCleanup = () => {
      purgeSessions()
        .then((count) => {
          if (count > 0) {
            console.info(`Purged ${count} expired session(s)`);
          }
        })
        .catch((error) => {
          console.error("Session cleanup error:", error);
        });
      this.cleanupInterval = setTimeout(runCleanup, 1000 * 60 * 60);
    };

    // Initial cleanup after 1 minute (give server time to start)
    this.cleanupInterval = setTimeout(runCleanup, 1000 * 60);
  }

  get(
    sid: string,
    callback: (err: Error | null, session?: ExpressSessionData | null) => void,
  ): void {
    sessionsTable
      .queryOne({ [SESSION_ID]: sid })
      .then((model) => {
        if (!model) return callback(null, null);
        callback(null, model.toJSON());
      })
      .catch(callback);
  }

  set(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    const row = SessionModel.fromSessionData(sid, session);
    sessionsTable
      .upsert(row, Object.keys(row).filter((k) => k !== SESSION_ID))
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  destroy(sid: string, callback?: (err?: Error) => void): void {
    sessionsTable
      .hardDelete(sid)
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  touch(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    const row = SessionModel.fromSessionData(sid, session);
    const updateData = { ...row };
    delete (updateData as Record<string, unknown>)[SESSION_ID];

    sessionsTable
      .update(sid, updateData)
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }
}
