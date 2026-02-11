import { Store, SessionData as ExpressSessionData } from "express-session";
import { QueryResult } from "pg";
import { pool } from "../client";
import { SessionModel, SESSIONS, SESSION_ID } from "../models";
import { buildUpsert, buildUpdate, selectWithFilters } from "../database";

export class PostgresSessionStore extends Store {
  get(
    sid: string,
    callback: (err: Error | null, session?: ExpressSessionData | null) => void
  ): void {
    selectWithFilters<Record<string, unknown>>(pool, SESSIONS, "*", {
      primaryKey: { column: SESSION_ID, value: sid },
      excludeDeleted: false,
    })
      .then((rows) => {
        if (rows.length === 0) return callback(null, null);
        try {
          const model = new SessionModel(rows[0]);
          callback(null, model.toSessionData());
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .catch(callback);
  }

  set(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    const row = SessionModel.fromSessionData(sid, session);
    const { sql, values } = buildUpsert(SESSIONS, SESSION_ID, row, {
      updateColumns: Object.keys(row).filter(k => k !== SESSION_ID),
      returning: [SESSION_ID],
    });

    pool
      .query(sql, values)
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  destroy(sid: string, callback?: (err?: Error) => void): void {
    pool
      .query(`DELETE FROM ${SESSIONS} WHERE ${SESSION_ID} = $1`, [sid])
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }

  touch(sid: string, session: ExpressSessionData, callback?: (err?: Error) => void): void {
    const row = SessionModel.fromSessionData(sid, session);
    const updateData = { ...row };
    delete (updateData as Record<string, unknown>)[SESSION_ID];
    
    const query = buildUpdate(SESSIONS, SESSION_ID, sid, updateData);
    if (!query) {
      callback && callback();
      return;
    }

    pool
      .query(query.sql, query.values)
      .then(() => callback && callback())
      .catch((error: Error) => callback && callback(error));
  }
}
