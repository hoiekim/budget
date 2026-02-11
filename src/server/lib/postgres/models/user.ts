/**
 * User model and schema definition.
 */

import { isString } from "common";
import {
  USER_ID,
  USERNAME,
  PASSWORD,
  EMAIL,
  EXPIRY,
  TOKEN,
  UPDATED,
  IS_DELETED,
  USERS,
} from "./common";
import {
  Schema,
  Constraints,
  Table,
  PropertyChecker,
  AssertTypeFn,
  createAssertType,
  Model,
  isNullableString,
  isNullableDate,
  isNullableBoolean,
  toDate,
} from "./base";

export interface UserRow {
  user_id: string;
  username: string;
  password: string | null | undefined;
  email: string | null | undefined;
  expiry: Date | null | undefined;
  token: string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

export interface MaskedUser {
  user_id: string;
  username: string;
}

export type User = MaskedUser & { password: string };

export class UserModel extends Model<UserRow, MaskedUser> {
  user_id: string;
  username: string;
  password: string | null;
  email: string | null;
  expiry: Date | null;
  token: string | null;
  updated: Date;
  is_deleted: boolean;

  constructor(row: UserRow) {
    super();
    UserModel.assertType(row);
    this.user_id = row.user_id;
    this.username = row.username;
    this.password = row.password ?? null;
    this.email = row.email ?? null;
    this.expiry = row.expiry ? toDate(row.expiry) : null;
    this.token = row.token ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  toJSON(): MaskedUser {
    return this.toMaskedUser();
  }

  toMaskedUser(): MaskedUser {
    return {
      user_id: this.user_id,
      username: this.username,
    };
  }

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

export const userTable: Table = {
  name: USERS,
  schema: userSchema as Schema<Record<string, unknown>>,
  constraints: userConstraints,
  indexes: [],
};
