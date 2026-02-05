import { pool } from "./client";
import { Store, SessionData as ExpressSessionData } from "express-session";

/**
 * PostgreSQL Session Store for express-session
 */
export class PostgresSessionStore extends Store {
  get(sid: string, callback: (err: any, session?: ExpressSessionData | null) => void) {
    pool.query(
      `SELECT data FROM sessions WHERE session_id = $1`,
      [sid]
    ).then(result => {
      if (result.rows.length === 0) {
        return callback(null, null);
      }
      callback(null, result.rows[0].data);
    }).catch(error => {
      callback(error);
    });
  }

  set(sid: string, session: ExpressSessionData, callback?: (err?: any) => void) {
    pool.query(
      `INSERT INTO sessions (session_id, data, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) DO UPDATE SET data = $2`,
      [sid, JSON.stringify(session)]
    ).then(() => {
      callback?.();
    }).catch(error => {
      callback?.(error);
    });
  }

  destroy(sid: string, callback?: (err?: any) => void) {
    pool.query(`DELETE FROM sessions WHERE session_id = $1`, [sid])
      .then(() => callback?.())
      .catch(error => callback?.(error));
  }

  touch(sid: string, session: ExpressSessionData, callback?: (err?: any) => void) {
    pool.query(
      `UPDATE sessions SET data = $2 WHERE session_id = $1`,
      [sid, JSON.stringify(session)]
    ).then(() => {
      callback?.();
    }).catch(error => {
      callback?.(error);
    });
  }
}

/**
 * Gets a session by ID (for internal use).
 */
export const getSession = async (session_id: string): Promise<any | null> => {
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
  data: any
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
  } catch (error: any) {
    console.error(`Failed to set session ${session_id}:`, error.message);
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
