/**
 * User model and schema definition.
 */

import {
  USER_ID,
  USERNAME,
  PASSWORD,
  EMAIL,
  EXPIRY,
  TOKEN,
  UPDATED,
  IS_DELETED,
} from "./common";
import {
  Schema,
  Constraints,
  PropertyChecker,
  AssertTypeFn,
  createAssertType,
  isString,
  isNullableString,
  isNullableDate,
  isNullableBoolean,
  toDate,
} from "./base";

// =============================================
// Interfaces
// =============================================

/**
 * User row as stored in the database.
 */
export interface UserRow {
  user_id: string;
  username: string;
  password: string | null;
  email: string | null;
  expiry: Date | null;
  token: string | null;
  updated: Date | null;
  is_deleted: boolean | null;
}

/**
 * Masked user (without password) for external use.
 */
export interface MaskedUser {
  user_id: string;
  username: string;
}

/**
 * Full user type including password.
 */
export type User = MaskedUser & { password: string };

// =============================================
// Model Class
// =============================================

export class UserModel {
  user_id: string;
  username: string;
  password: string | null;
  email: string | null;
  expiry: Date | null;
  token: string | null;
  updated: Date;
  is_deleted: boolean;

  constructor(row: UserRow) {
    UserModel.assertType(row);
    this.user_id = row.user_id;
    this.username = row.username;
    this.password = row.password;
    this.email = row.email;
    this.expiry = row.expiry ? toDate(row.expiry) : null;
    this.token = row.token;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  /**
   * Creates a MaskedUser from this model.
   */
  toMaskedUser(): MaskedUser {
    return {
      user_id: this.user_id,
      username: this.username,
    };
  }

  /**
   * Creates a User from this model (includes password).
   * Throws if password is null.
   */
  toUser(): User {
    if (this.password === null) {
      throw new Error("User has no password set");
    }
    return {
      user_id: this.user_id,
      username: this.username,
      password: this.password,
    };
  }

  static assertType: AssertTypeFn<UserRow> = createAssertType<UserRow>("UserModel", {
    user_id: isString,
    username: isString,
    password: isNullableString,
    email: isNullableString,
    expiry: isNullableDate,
    token: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  } as PropertyChecker<UserRow>);
}

// =============================================
// Schema Definition
// =============================================

export const userSchema: Schema<UserRow> = {
  [USER_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USERNAME]: "VARCHAR(255) UNIQUE NOT NULL",
  [PASSWORD]: "VARCHAR(255)",
  [EMAIL]: "VARCHAR(255)",
  [EXPIRY]: "TIMESTAMPTZ",
  [TOKEN]: "VARCHAR(255)",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const userConstraints: Constraints = [];

export const userColumns = Object.keys(userSchema);
