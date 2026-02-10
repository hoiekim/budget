import { pool } from "./client";
import { QueryResult } from "pg";
import { Store, SessionData as ExpressSessionData } from "express-session";

interface SessionRow {
  session_id: string;
  user_user_id: string;
  user_username: string;
  cookie_original_max_age?: string | null;
  cookie_max_age?: string | null;
  cookie_signed?: boolean | null;
  cookie_expires?: Date | null;
  cookie_http_only?: boolean | null;
  cookie_path?: string | null;
  cookie_domain?: string | null;
  cookie_secure?: boolean | null;
  cookie_same_site?: string | null;
  created_at: Date;
  updated: Date;
}

const getUser = (row: SessionRow): ExpressSessionData["user"] => ({
  user_id: row.user_user_id,
  username: row.user_username,
});

const getCookie = (row: SessionRow): ExpressSessionData["cookie"] => {
  let sameSite: boolean | "lax" | "strict" | "none" | undefined;
  switch (row.cookie_same_site) {
    case "true":
      sameSite = true;
      break;
    case "false":
      sameSite = false;
      break;
    case "lax":
      sameSite = "lax";
      break;
    case "strict":
      sameSite = "strict";
      break;
    case "none":
      sameSite = "none";
      break;
    default:
      sameSite = undefined;
  }
  return {
    originalMaxAge: row.cookie_original_max_age ? parseInt(row.cookie_original_max_age) : null,
    maxAge: row.cookie_max_age ? parseInt(row.cookie_max_age) : undefined,
    signed: row.cookie_signed || undefined,
    expires: row.cookie_expires,
    httpOnly: row.cookie_http_only || undefined,
    path: row.cookie_path || undefined,
    domain: row.cookie_domain || undefined,
    secure: row.cookie_secure || undefined,
    sameSite,
  };
};

/**
 * PostgreSQL Session Store for express-session
 */
export class PostgresSessionStore extends Store {
  get(
    sid: string,
    callback: (err: Error | null, session?: ExpressSessionData | null) => void,
  ): void {
    pool
      .query<SessionRow>(`SELECT * FROM sessions WHERE session_id = $1`, [sid])
      .then((result: QueryResult<SessionRow>) => {
        if (result.rows.length === 0) return callback(null, null);
        const row = result.rows[0];
        const sessionData: ExpressSessionData = {
          user: getUser(row),
          cookie: getCookie(row),
        };
        callback(null, sessionData);
      })
      .catch(callback);
  }

  set(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    pool
      .query(
        `INSERT INTO sessions (session_id,
        user_user_id, user_username, cookie_original_max_age, cookie_max_age,
        cookie_signed, cookie_expires, cookie_http_only, cookie_path, cookie_domain,
        cookie_secure, cookie_same_site, updated, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (session_id) DO UPDATE
        SET user_user_id = $2,
        user_username = $3,
        cookie_original_max_age = $4,
        cookie_max_age = $5,
        cookie_signed = $6,
        cookie_expires = $7,
        cookie_http_only = $8,
        cookie_path = $9,
        cookie_domain = $10,
        cookie_secure = $11,
        cookie_same_site = $12,
        updated = CURRENT_TIMESTAMP`,
        [
          sid,
          session.user.user_id,
          session.user.username,
          session.cookie.originalMaxAge,
          session.cookie.maxAge,
          session.cookie.signed,
          session.cookie.expires,
          session.cookie.httpOnly,
          session.cookie.path,
          session.cookie.domain,
          session.cookie.secure,
          session.cookie.sameSite,
        ],
      )
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  destroy(sid: string, callback?: (err?: Error) => void): void {
    pool
      .query(`DELETE FROM sessions WHERE session_id = $1`, [sid])
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  touch(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    pool
      .query(
        `UPDATE sessions SET
        user_user_id = $2,
        user_username = $3,
        cookie_original_max_age = $4,
        cookie_max_age = $5,
        cookie_signed = $6,
        cookie_expires = $7,
        cookie_http_only = $8,
        cookie_path = $9,
        cookie_domain = $10,
        cookie_secure = $11,
        cookie_same_site = $12,
        updated = CURRENT_TIMESTAMP
        WHERE session_id = $1`,
        [
          sid,
          session.user.user_id,
          session.user.username,
          session.cookie.originalMaxAge,
          session.cookie.maxAge,
          session.cookie.signed,
          session.cookie.expires,
          session.cookie.httpOnly,
          session.cookie.path,
          session.cookie.domain,
          session.cookie.secure,
          session.cookie.sameSite,
        ],
      )
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }
}
