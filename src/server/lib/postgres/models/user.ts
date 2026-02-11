import { isString, isNullableString, isNullableDate, isNullableBoolean } from "common";
import { USER_ID, USERNAME, PASSWORD, EMAIL, EXPIRY, TOKEN, UPDATED, IS_DELETED, USERS } from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";
import { toDate } from "../util";

export interface MaskedUser {
  user_id: string;
  username: string;
}

export type User = MaskedUser & { password: string };

export class UserModel extends Model<MaskedUser> {
  user_id: string;
  username: string;
  password: string | null;
  email: string | null;
  expiry: Date | null;
  token: string | null;
  updated: Date;
  is_deleted: boolean;

  constructor(data: unknown) {
    super();
    UserModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.user_id = r.user_id as string;
    this.username = r.username as string;
    this.password = (r.password as string) ?? null;
    this.email = (r.email as string) ?? null;
    this.expiry = r.expiry ? toDate(r.expiry) : null;
    this.token = (r.token as string) ?? null;
    this.updated = r.updated ? toDate(r.updated) : new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
  }

  toJSON(): MaskedUser {
    return { user_id: this.user_id, username: this.username };
  }

  toMaskedUser(): MaskedUser {
    return this.toJSON();
  }

  toUser(): User {
    if (this.password === null) throw new Error("User has no password set");
    return { user_id: this.user_id, username: this.username, password: this.password };
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("UserModel", {
    user_id: isString,
    username: isString,
    password: isNullableString,
    email: isNullableString,
    expiry: isNullableDate,
    token: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export const usersTable = createTable({
  name: USERS,
  schema: {
    [USER_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USERNAME]: "VARCHAR(255) UNIQUE NOT NULL",
    [PASSWORD]: "VARCHAR(255)",
    [EMAIL]: "VARCHAR(255)",
    [EXPIRY]: "TIMESTAMPTZ",
    [TOKEN]: "VARCHAR(255)",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  ModelClass: UserModel,
});

export const userColumns = Object.keys(usersTable.schema);
