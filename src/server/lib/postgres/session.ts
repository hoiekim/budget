import { pool } from "./client";

export interface SessionData {
  user?: {
    user_id: string;
    username: string;
  };
  cookie?: {
    originalMaxAge?: number;
    maxAge?: number;
    signed?: boolean;
    _expires?: string;
    httpOnly?: boolean;
    path?: string;
    domain?: string;
    secure?: string;
    sameSite?: string;
  };
}

/**
 * Gets a session by ID.
 */
export const getSession = async (session_id: string): Promise<SessionData | null> => {
  const result = await pool.query(
    `SELECT * FROM sessions WHERE session_id = $1`,
    [session_id]
  );
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    user: row.user_user_id ? {
      user_id: row.user_user_id,
      username: row.user_username,
    } : undefined,
    cookie: {
      originalMaxAge: row.cookie_original_max_age,
      maxAge: row.cookie_max_age,
      signed: row.cookie_signed,
      _expires: row.cookie_expires,
      httpOnly: row.cookie_http_only,
      path: row.cookie_path,
      domain: row.cookie_domain,
      secure: row.cookie_secure,
      sameSite: row.cookie_same_site,
    },
  };
};

/**
 * Sets/updates a session.
 */
export const setSession = async (
  session_id: string,
  data: SessionData
): Promise<boolean> => {
  try {
    const result = await pool.query(
      `INSERT INTO sessions (
        session_id, 
        user_user_id, user_username,
        cookie_original_max_age, cookie_max_age, cookie_signed,
        cookie_expires, cookie_http_only, cookie_path, cookie_domain,
        cookie_secure, cookie_same_site,
        updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
      ON CONFLICT (session_id) DO UPDATE SET
        user_user_id = $2, user_username = $3,
        cookie_original_max_age = $4, cookie_max_age = $5, cookie_signed = $6,
        cookie_expires = $7, cookie_http_only = $8, cookie_path = $9, cookie_domain = $10,
        cookie_secure = $11, cookie_same_site = $12,
        updated = CURRENT_TIMESTAMP
      RETURNING session_id`,
      [
        session_id,
        data.user?.user_id,
        data.user?.username,
        data.cookie?.originalMaxAge,
        data.cookie?.maxAge,
        data.cookie?.signed,
        data.cookie?._expires,
        data.cookie?.httpOnly,
        data.cookie?.path,
        data.cookie?.domain,
        data.cookie?.secure,
        data.cookie?.sameSite,
      ]
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

/**
 * Clears expired sessions.
 */
export const clearExpiredSessions = async (): Promise<number> => {
  const result = await pool.query(
    `DELETE FROM sessions WHERE cookie_expires < CURRENT_TIMESTAMP RETURNING session_id`
  );
  return result.rowCount || 0;
};

/**
 * Gets all sessions for a user.
 */
export const getUserSessions = async (user_id: string): Promise<string[]> => {
  const result = await pool.query(
    `SELECT session_id FROM sessions WHERE user_user_id = $1`,
    [user_id]
  );
  return result.rows.map(row => row.session_id);
};

/**
 * Destroys all sessions for a user.
 */
export const destroyUserSessions = async (user_id: string): Promise<number> => {
  const result = await pool.query(
    `DELETE FROM sessions WHERE user_user_id = $1 RETURNING session_id`,
    [user_id]
  );
  return result.rowCount || 0;
};
