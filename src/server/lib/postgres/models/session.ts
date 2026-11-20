import { isString, isNullableString, isNullableBoolean, isNullableNumber } from "common";
import type { MaskedUser } from "./user";
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
  AUTH_SID,
  AUTH_REFRESH_TOKEN,
  AUTH_RECHECK_AT,
} from "./common";
import { SESSIONS } from "common/constants";

import { Model, RowValueType, createTable } from "./base";

export interface SessionCookie {
  originalMaxAge?: number | null;
  maxAge?: number;
  signed?: boolean;
  expires?: Date;
  httpOnly?: boolean;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
}

/** What a session started by single sign-on keeps about its sign-in at the identity provider. */
export interface SessionAuth {
  /** The provider's session id (`sid`), which `session.ended` names. */
  sid: string;
  refreshToken: string | null;
  /** When the next request must re-check the sign-in with the provider. */
  recheckAt: Date;
}

export interface SessionData {
  user: MaskedUser;
  cookie: SessionCookie;
  /** Absent on a session started by the app's own password sign-in. */
  auth?: SessionAuth;
}

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
  [AUTH_SID]: "TEXT",
  [AUTH_REFRESH_TOKEN]: "TEXT",
  [AUTH_RECHECK_AT]: "TIMESTAMPTZ",
};

type SessionSchema = typeof sessionSchema;
type SessionRow = { [k in keyof SessionSchema]: RowValueType };

export class SessionModel extends Model<SessionData, SessionSchema> implements SessionRow {
  declare session_id: string;
  declare user_user_id: string;
  declare user_username: string;
  declare cookie_original_max_age: number | null;
  declare cookie_max_age: number | null;
  declare cookie_signed: boolean | null;
  declare cookie_expires: string | null;
  declare cookie_http_only: boolean | null;
  declare cookie_path: string | null;
  declare cookie_domain: string | null;
  declare cookie_secure: boolean | null;
  declare cookie_same_site: boolean | "lax" | "strict" | "none" | null;
  declare created_at: string | null;
  declare updated: string | null;
  declare auth_sid: string | null;
  declare auth_refresh_token: string | null;
  declare auth_recheck_at: string | null;

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
    auth_sid: isNullableString,
    auth_refresh_token: isNullableString,
    auth_recheck_at: isNullableString,
  };

  constructor(data: unknown) {
    super(data, SessionModel.typeChecker);
  }

  toJSON(): SessionData {
    const data: SessionData = {
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
    if (this.auth_sid !== null) {
      data.auth = {
        sid: this.auth_sid,
        refreshToken: this.auth_refresh_token,
        recheckAt: new Date(this.auth_recheck_at ?? 0),
      };
    }
    return data;
  }

  /** Leaves the `auth_*` columns out when `data` has no `auth`, so writing it keeps what the row holds. */
  static fromSessionData(sid: string, data: SessionData): Partial<SessionRow> {
    const row: Partial<SessionRow> = {
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
    if (data.auth) Object.assign(row, SessionModel.fromSessionAuth(data.auth));
    return row;
  }

  static fromSessionAuth(auth: SessionAuth): Partial<SessionRow> {
    return {
      auth_sid: auth.sid,
      auth_refresh_token: auth.refreshToken,
      auth_recheck_at: auth.recheckAt,
    };
  }
}

export const sessionsTable = createTable({
  name: SESSIONS,
  primaryKey: SESSION_ID,
  schema: sessionSchema,
  ModelClass: SessionModel,
  indexes: [{ column: USER_USER_ID }, { column: AUTH_SID }],
  supportsSoftDelete: false,
});

export const sessionColumns = Object.keys(sessionsTable.schema);
