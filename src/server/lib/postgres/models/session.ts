import { isString, isNullableString, isNullableBoolean, isNullableNumber } from "common";
import { SessionData as ExpressSessionData } from "express-session";
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
  SESSIONS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const isValidSameSiteValue = (v: unknown): boolean => {
  if (typeof v === "boolean") return true;
  if (v === "true") return true;
  if (v === "false") return true;
  if (v === "lax" || v === "strict" || v === "none") return true;
  if (v === null) return true;
  return false;
};

const sessionSchema = {
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
};

type SessionSchema = typeof sessionSchema;
type SessionRow = { [k in keyof SessionSchema]: RowValueType };

export class SessionModel extends Model<ExpressSessionData, SessionSchema> implements SessionRow {
  session_id!: string;
  user_user_id!: string;
  user_username!: string;
  cookie_original_max_age!: number | null;
  cookie_max_age!: number | null;
  cookie_signed!: boolean | null;
  cookie_expires!: string | null;
  cookie_http_only!: boolean | null;
  cookie_path!: string | null;
  cookie_domain!: string | null;
  cookie_secure!: boolean | null;
  cookie_same_site!: boolean | "lax" | "strict" | "none" | null;
  created_at!: string | null;
  updated!: string | null;

  static typeChecker = {
    session_id: isString,
    user_user_id: isString,
    user_username: isString,
    cookie_original_max_age: isNullableNumber,
    cookie_max_age: isNullableNumber,
    cookie_signed: isNullableBoolean,
    cookie_expires: isNullableString,
    cookie_http_only: isNullableBoolean,
    cookie_path: isNullableString,
    cookie_domain: isNullableString,
    cookie_secure: isNullableBoolean,
    cookie_same_site: isValidSameSiteValue,
    created_at: isNullableString,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, SessionModel.typeChecker);
  }

  toJSON(): ExpressSessionData {
    return {
      user: { user_id: this.user_user_id, username: this.user_username },
      cookie: {
        originalMaxAge: this.cookie_original_max_age,
        maxAge: this.cookie_max_age || undefined,
        signed: this.cookie_signed || undefined,
        expires: this.cookie_expires ? new Date(this.cookie_expires) : undefined,
        httpOnly: this.cookie_http_only || undefined,
        path: this.cookie_path || undefined,
        domain: this.cookie_domain || undefined,
        secure: this.cookie_secure || undefined,
        sameSite: this.cookie_same_site || undefined,
      },
    };
  }

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
}

export const sessionsTable = createTable({
  name: SESSIONS,
  primaryKey: SESSION_ID,
  schema: sessionSchema,
  ModelClass: SessionModel,
  supportsSoftDelete: false,
});

export const sessionColumns = Object.keys(sessionsTable.schema);
