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
  IndexDefinition,
  Table,
  AssertTypeFn,
  createAssertType,
  Model,
  isNullableString,
  isNullableDate,
  isNullableBoolean,
  toDate,
} from "./base";

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
    const row = data as Record<string, unknown>;
    this.user_id = row.user_id as string;
    this.username = row.username as string;
    this.password = (row.password as string) ?? null;
    this.email = (row.email as string) ?? null;
    this.expiry = row.expiry ? toDate(row.expiry) : null;
    this.token = (row.token as string) ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
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

export class UsersTable extends Table<MaskedUser, UserModel> {
  readonly name = USERS;
  readonly schema: Schema<Record<string, unknown>> = {
    [USER_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USERNAME]: "VARCHAR(255) UNIQUE NOT NULL",
    [PASSWORD]: "VARCHAR(255)",
    [EMAIL]: "VARCHAR(255)",
    [EXPIRY]: "TIMESTAMPTZ",
    [TOKEN]: "VARCHAR(255)",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  };
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [];
  readonly ModelClass = UserModel;
}

export const usersTable = new UsersTable();
export const userColumns = Object.keys(usersTable.schema);
