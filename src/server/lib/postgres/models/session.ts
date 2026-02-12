import { isString, isNullableString, isNullableBoolean, isNullableDate } from "common";
import { SessionData as ExpressSessionData } from "express-session";
import {
  SESSION_ID, USER_USER_ID, USER_USERNAME, COOKIE_ORIGINAL_MAX_AGE, COOKIE_MAX_AGE,
  COOKIE_SIGNED, COOKIE_EXPIRES, COOKIE_HTTP_ONLY, COOKIE_PATH, COOKIE_DOMAIN,
  COOKIE_SECURE, COOKIE_SAME_SITE, CREATED_AT, UPDATED, SESSIONS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class SessionModel extends Model<ExpressSessionData> {
  session_id: string;
  user_user_id: string;
  user_username: string;
  cookie_original_max_age: number | null;
  cookie_max_age: number | undefined;
  cookie_signed: boolean | undefined;
  cookie_expires: Date | undefined;
  cookie_http_only: boolean | undefined;
  cookie_path: string | undefined;
  cookie_domain: string | undefined;
  cookie_secure: boolean | undefined;
  cookie_same_site: boolean | "lax" | "strict" | "none" | undefined;
  created_at: Date;
  updated: Date;

  constructor(data: unknown) {
    super();
    SessionModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.session_id = r.session_id as string;
    this.user_user_id = r.user_user_id as string;
    this.user_username = r.user_username as string;
    this.cookie_original_max_age = r.cookie_original_max_age ? parseInt(r.cookie_original_max_age as string, 10) : null;
    this.cookie_max_age = r.cookie_max_age ? parseInt(r.cookie_max_age as string, 10) : undefined;
    this.cookie_signed = (r.cookie_signed as boolean) ?? undefined;
    this.cookie_expires = (r.cookie_expires as Date) ?? undefined;
    this.cookie_http_only = (r.cookie_http_only as boolean) ?? undefined;
    this.cookie_path = (r.cookie_path as string) ?? undefined;
    this.cookie_domain = (r.cookie_domain as string) ?? undefined;
    this.cookie_secure = (r.cookie_secure as boolean) ?? undefined;
    this.cookie_same_site = this.parseSameSite(r.cookie_same_site as string);
    this.created_at = (r.created_at as Date) ?? new Date();
    this.updated = (r.updated as Date) ?? new Date();
  }

  private parseSameSite(v: string | null | undefined): boolean | "lax" | "strict" | "none" | undefined {
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "lax" || v === "strict" || v === "none") return v;
    return undefined;
  }

  toJSON(): ExpressSessionData {
    return this.toSessionData();
  }

  toSessionData(): ExpressSessionData {
    return {
      user: { user_id: this.user_user_id, username: this.user_username },
      cookie: {
        originalMaxAge: this.cookie_original_max_age,
        maxAge: this.cookie_max_age,
        signed: this.cookie_signed,
        expires: this.cookie_expires,
        httpOnly: this.cookie_http_only,
        path: this.cookie_path,
        domain: this.cookie_domain,
        secure: this.cookie_secure,
        sameSite: this.cookie_same_site,
      },
    };
  }

  static fromSessionData(sid: string, data: ExpressSessionData): Record<string, unknown> {
    return {
      session_id: sid,
      user_user_id: data.user.user_id,
      user_username: data.user.username,
      cookie_original_max_age: data.cookie.originalMaxAge?.toString() ?? null,
      cookie_max_age: data.cookie.maxAge?.toString() ?? null,
      cookie_signed: data.cookie.signed ?? null,
      cookie_expires: data.cookie.expires ?? null,
      cookie_http_only: data.cookie.httpOnly ?? null,
      cookie_path: data.cookie.path ?? null,
      cookie_domain: data.cookie.domain ?? null,
      cookie_secure: typeof data.cookie.secure === "boolean" ? data.cookie.secure : null,
      cookie_same_site: data.cookie.sameSite?.toString() ?? null,
    };
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SessionModel", {
    session_id: isString,
    user_user_id: isString,
    user_username: isString,
    cookie_original_max_age: isNullableString,
    cookie_max_age: isNullableString,
    cookie_signed: isNullableBoolean,
    cookie_expires: isNullableDate,
    cookie_http_only: isNullableBoolean,
    cookie_path: isNullableString,
    cookie_domain: isNullableString,
    cookie_secure: isNullableBoolean,
    cookie_same_site: isNullableString,
    created_at: isNullableDate,
    updated: isNullableDate,
  });
}

export const sessionsTable = createTable({
  name: SESSIONS,
  primaryKey: SESSION_ID,
  schema: {
    [SESSION_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_USER_ID]: "UUID",
    [USER_USERNAME]: "VARCHAR(255)",
    [COOKIE_ORIGINAL_MAX_AGE]: "BIGINT",
    [COOKIE_MAX_AGE]: "BIGINT",
    [COOKIE_SIGNED]: "BOOLEAN",
    [COOKIE_EXPIRES]: "TIMESTAMPTZ",
    [COOKIE_HTTP_ONLY]: "BOOLEAN",
    [COOKIE_PATH]: "TEXT",
    [COOKIE_DOMAIN]: "TEXT",
    [COOKIE_SECURE]: "BOOLEAN",
    [COOKIE_SAME_SITE]: "VARCHAR(50)",
    [CREATED_AT]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  } as Schema<Record<string, unknown>>,
  ModelClass: SessionModel,
});

export const sessionColumns = Object.keys(sessionsTable.schema);
