/**
 * Session repository - PostgreSQL session store for express-session.
 */

import { Store, SessionData as ExpressSessionData } from "express-session";
import { QueryResult } from "pg";
import { pool } from "../client";
import { SessionModel, SessionRow, SESSIONS, SESSION_ID } from "../models";

/**
 * PostgreSQL Session Store for express-session.
 */
export class PostgresSessionStore extends Store {
  /**
   * Gets a session by ID.
   */
  get(
    sid: string,
    callback: (err: Error | null, session?: ExpressSessionData | null) => void
  ): void {
    pool
      .query<SessionRow>(`SELECT * FROM ${SESSIONS} WHERE ${SESSION_ID} = $1`, [sid])
      .then((result: QueryResult<SessionRow>) => {
        if (result.rows.length === 0) return callback(null, null);
        
        try {
          const model = new SessionModel(result.rows[0]);
          callback(null, model.toSessionData());
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .catch(callback);
  }

  /**
   * Sets (creates or updates) a session.
   */
  set(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    const row = SessionModel.fromSessionData(sid, session);

    pool
      .query(
        `INSERT INTO ${SESSIONS} (
          ${SESSION_ID},
          user_user_id, user_username,
          cookie_original_max_age, cookie_max_age,
          cookie_signed, cookie_expires, cookie_http_only,
          cookie_path, cookie_domain, cookie_secure, cookie_same_site,
          updated, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (${SESSION_ID}) DO UPDATE
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
          row.user_user_id,
          row.user_username,
          row.cookie_original_max_age,
          row.cookie_max_age,
          row.cookie_signed,
          row.cookie_expires,
          row.cookie_http_only,
          row.cookie_path,
          row.cookie_domain,
          row.cookie_secure,
          row.cookie_same_site,
        ]
      )
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  /**
   * Destroys (deletes) a session.
   */
  destroy(sid: string, callback?: (err?: Error) => void): void {
    pool
      .query(`DELETE FROM ${SESSIONS} WHERE ${SESSION_ID} = $1`, [sid])
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  /**
   * Touches (updates) a session's expiry.
   */
  touch(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    const row = SessionModel.fromSessionData(sid, session);

    pool
      .query(
        `UPDATE ${SESSIONS} SET
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
        WHERE ${SESSION_ID} = $1`,
        [
          sid,
          row.user_user_id,
          row.user_username,
          row.cookie_original_max_age,
          row.cookie_max_age,
          row.cookie_signed,
          row.cookie_expires,
          row.cookie_http_only,
          row.cookie_path,
          row.cookie_domain,
          row.cookie_secure,
          row.cookie_same_site,
        ]
      )
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }
}
