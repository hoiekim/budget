import { pool } from "./client";
import { QueryResult } from "pg";
import { Store, SessionData as ExpressSessionData } from "express-session";

interface SessionRow {
  data: ExpressSessionData;
}

/**
 * PostgreSQL Session Store for express-session
 */
export class PostgresSessionStore extends Store {
  get(sid: string, callback: (err: Error | null, session?: ExpressSessionData | null) => void): void {
    pool.query<SessionRow>(
      `SELECT data FROM sessions WHERE session_id = $1`,
      [sid]
    ).then((result: QueryResult<SessionRow>) => {
      if (result.rows.length === 0) {
        return callback(null, null);
      }
      callback(null, result.rows[0].data);
    }).catch((error: Error) => {
      callback(error);
    });
  }

  set(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    pool.query(
      `INSERT INTO sessions (session_id, data, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) DO UPDATE SET data = $2`,
      [sid, JSON.stringify(session)]
    ).then(() => {
      callback?.();
    }).catch((error: Error) => {
      callback?.(error);
    });
  }

  destroy(sid: string, callback?: (err?: Error) => void): void {
    pool.query(`DELETE FROM sessions WHERE session_id = $1`, [sid])
      .then(() => callback?.())
      .catch((error: Error) => callback?.(error));
  }

  touch(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    pool.query(
      `UPDATE sessions SET data = $2 WHERE session_id = $1`,
      [sid, JSON.stringify(session)]
    ).then(() => {
      callback?.();
    }).catch((error: Error) => {
      callback?.(error);
    });
  }
}

/**
 * Gets a session by ID (for internal use).
 */
export const getSession = async (session_id: string): Promise<ExpressSessionData | null> => {
  const result = await pool.query(
    `SELECT data FROM sessions WHERE session_id = $1`,
    [session_id]
  );
  
  if (result.rows.length === 0) return null;
  return result.rows[0].data;
};

/**
 * Sets/updates a session (for internal use).
 */
export const setSession = async (
  session_id: string,
  data: ExpressSessionData
): Promise<boolean> => {
  try {
    const result = await pool.query(
      `INSERT INTO sessions (session_id, data, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) DO UPDATE SET data = $2
       RETURNING session_id`,
      [session_id, JSON.stringify(data)]
    );
    return (result.rowCount || 0) > 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to set session ${session_id}:`, message);
    return false;
  }
};

/**
 * Destroys a session.
 */
export const destroySession = async (session_id: string): Promise<boolean> => {
  const result = await pool.query(
    `DELETE FROM sessions WHERE session_id = $1 RETURNING session_id`,
    [session_id]
  );
  return (result.rowCount || 0) > 0;
};
