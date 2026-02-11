/**
 * Session model and schema definition.
 */

import { isString } from "common";
import {
  SESSION_ID,
  USER_USER_ID,
  USER_USERNAME,
  COOKIE_ORIGINAL_MAX_AGE,
  COOKIE_MAX_AGE,
  COOKIE_SIGNED,
  COOKIE_EXPIRES,
  COOKIE_HTTP_ONLY,
  COOKIE_PATH,
  COOKIE_DOMAIN,
  COOKIE_SECURE,
  COOKIE_SAME_SITE,
  CREATED_AT,
  UPDATED,
} from "./common";
import {
  Schema,
  Table,
  PropertyChecker,
  AssertTypeFn,
  createAssertType,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  toDate,
} from "./base";
import { SessionData as ExpressSessionData } from "express-session";

// Interfaces

/**
 * Session row as stored in the database.
 */
export interface SessionRow {
  session_id: string;
  user_user_id: string;
  user_username: string;
  cookie_original_max_age: string | null | undefined;
  cookie_max_age: string | null | undefined;
  cookie_signed: boolean | null | undefined;
  cookie_expires: Date | null | undefined;
  cookie_http_only: boolean | null | undefined;
  cookie_path: string | null | undefined;
  cookie_domain: string | null | undefined;
  cookie_secure: boolean | null | undefined;
  cookie_same_site: string | null | undefined;
  created_at: Date;
  updated: Date;
}

// Model Class

export class SessionModel {
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

  constructor(row: SessionRow) {
    SessionModel.assertType(row);
    this.session_id = row.session_id;
    this.user_user_id = row.user_user_id;
    this.user_username = row.user_username;
    this.cookie_original_max_age = row.cookie_original_max_age
      ? parseInt(row.cookie_original_max_age, 10)
      : null;
    this.cookie_max_age = row.cookie_max_age
      ? parseInt(row.cookie_max_age, 10)
      : undefined;
    this.cookie_signed = row.cookie_signed ?? undefined;
    this.cookie_expires = row.cookie_expires ?? undefined;
    this.cookie_http_only = row.cookie_http_only ?? undefined;
    this.cookie_path = row.cookie_path ?? undefined;
    this.cookie_domain = row.cookie_domain ?? undefined;
    this.cookie_secure = row.cookie_secure ?? undefined;
    this.cookie_same_site = this.parseSameSite(row.cookie_same_site);
    this.created_at = toDate(row.created_at);
    this.updated = toDate(row.updated);
  }

  private parseSameSite(
    value: string | null | undefined
  ): boolean | "lax" | "strict" | "none" | undefined {
    switch (value) {
      case "true":
        return true;
      case "false":
        return false;
      case "lax":
        return "lax";
      case "strict":
        return "strict";
      case "none":
        return "none";
      default:
        return undefined;
    }
  }

  /**
   * Converts to ExpressSessionData format.
   */
  toSessionData(): ExpressSessionData {
    return {
      user: {
        user_id: this.user_user_id,
        username: this.user_username,
      },
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

  /**
   * Creates a SessionRow from ExpressSessionData.
   */
  static fromSessionData(sid: string, data: ExpressSessionData): Partial<SessionRow> {
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

  static assertType: AssertTypeFn<SessionRow> = createAssertType<SessionRow>("SessionModel", {
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
  } as PropertyChecker<SessionRow>);
}

// Schema Definition

export const sessionSchema: Schema<SessionRow> = {
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
  [COOKIE_SECURE]: "VARCHAR(50)",
  [COOKIE_SAME_SITE]: "VARCHAR(50)",
  [CREATED_AT]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

export const sessionColumns = Object.keys(sessionSchema);

export const sessionTable: Table = {
  name: "sessions",
  schema: sessionSchema as Schema<Record<string, unknown>>,
  constraints: [],
  indexes: [],
};
