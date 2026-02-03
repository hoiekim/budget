import { Store, SessionData, Cookie } from "express-session";
import { pool } from "./client";

/**
 * The REAL `Cookie` type that's used by express-session in runtime.
 */
export type RealCookie = Omit<Cookie, "expires"> & { _expires?: Date };

/**
 * Redefines some properties as they should be stringified before storing because
 * Postgres JSON doesn't support certain types directly.
 */
export type StoredCookie = Omit<RealCookie, "secure" | "sameSite"> & {
  secure?: string;
  sameSite?: string;
};

/**
 * `SessionData` imported from express-session contains cookie property which is
 * `Cookie` type, which doesn't match with runtime cookie object. `RealSessionData`
 * tries to define what's actually used in runtime.
 */
export type RealSessionData = Omit<SessionData, "cookie"> & { cookie: RealCookie };

/**
 * Redefines 'cookie' property to make it compatible with Postgres storage.
 */
export type StoredSessionData = Omit<SessionData, "cookie"> & { cookie: StoredCookie };

/**
 * Searches session data by id from Postgres.
 * @param session_id
 * @returns A promise to be a StoredSessionData object.
 */
export const searchSession = async (session_id: string) => {
  const result = await pool.query<{ data: StoredSessionData }>(
    `SELECT data FROM sessions WHERE session_id = $1`,
    [session_id]
  );
  return result.rows[0]?.data;
};

/**
 * Updates a session object with given session_id and session data.
 * @param session_id
 * @param session
 * @returns A promise with the query result.
 */
export const updateSession = async (session_id: string, session: StoredSessionData) => {
  return pool.query(
    `INSERT INTO sessions (session_id, data)
     VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET data = $2`,
    [session_id, JSON.stringify(session)]
  );
};

/**
 * Deletes a session object with given session_id.
 * @param session_id
 * @returns A promise with the query result.
 */
export const deleteSession = async (session_id: string) => {
  return pool.query(`DELETE FROM sessions WHERE session_id = $1`, [session_id]);
};

/**
 * Searches all expired session data and delete them.
 * @returns A promise with the query result.
 */
export const purgeSessions = async () => {
  const now = new Date().toISOString();
  return pool.query(
    `DELETE FROM sessions WHERE (data->'cookie'->>'_expires')::timestamp <= $1::timestamp`,
    [now]
  );
};

/**
 * Can be passed to 'store' option of express-session middleware to achieve persistent
 * session memory.
 */
export class PostgresSessionStore extends Store {
  constructor() {
    super();
    this.autoRemoveScheduler();
  }

  /**
   * Repeatedly run every hour to remove expired session data.
   */
  private autoRemoveScheduler = () => {
    purgeSessions().catch(console.error);
    setTimeout(this.autoRemoveScheduler, 1000 * 60 * 60);
  };

  /**
   * Gets session with given session_id.
   * @param session_id
   * @param callback
   * @returns
   */
  get = async (
    session_id: string,
    callback: (err: any, session?: RealSessionData | null) => void
  ) => {
    try {
      const session = await searchSession(session_id);

      if (!session) {
        callback(null, null);
        return;
      }

      const { cookie: storedCookie } = session;
      const { _expires, secure, sameSite } = storedCookie;
      if (!_expires || new Date(_expires) < new Date()) {
        this.destroy(session_id);
        return callback(null, null);
      }

      const cookie: RealCookie = {
        ...storedCookie,
        _expires: _expires && new Date(_expires),
        secure: secure && JSON.parse(secure),
        sameSite: sameSite && JSON.parse(sameSite),
      };

      return callback(null, { ...session, cookie });
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Sets session with given session_id and session object.
   * @param session_id
   * @param session
   * @param callback
   */
  set = async (session_id: string, session: RealSessionData, callback?: (err?: any) => void) => {
    if (!callback) return;

    try {
      const { cookie } = session;
      const { secure, sameSite } = cookie;

      const storedCookie: StoredCookie = {
        ...cookie,
        secure: JSON.stringify(secure),
        sameSite: JSON.stringify(sameSite),
      };

      await updateSession(session_id, { ...session, cookie: storedCookie });

      callback(null);
    } catch (error) {
      return callback(error);
    }
  };

  /**
   * Removes session data from Postgres by given session_id.
   * @param session_id
   * @param callback
   * @returns
   */
  destroy = async (session_id: string, callback?: (err?: any) => void) => {
    if (!callback) return;
    try {
      await deleteSession(session_id);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  };
}

// Keep backwards compatible export name
export { PostgresSessionStore as ElasticsearchSessionStore };
