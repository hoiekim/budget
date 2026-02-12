import { isString, isNullableString, isNullableBoolean } from "common";
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
import { Model, RowValueType, createTable } from "./base";

export interface MaskedUser {
  user_id: string;
  username: string;
}

export type User = MaskedUser & { password: string };

const userSchema = {
  [USER_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USERNAME]: "VARCHAR(255) UNIQUE NOT NULL",
  [PASSWORD]: "VARCHAR(255)",
  [EMAIL]: "VARCHAR(255)",
  [EXPIRY]: "TIMESTAMPTZ",
  [TOKEN]: "VARCHAR(255)",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type UserSchema = typeof userSchema;
type UserRow = { [k in keyof UserSchema]: RowValueType };

export class UserModel extends Model<MaskedUser, UserSchema> implements UserRow {
  user_id!: string;
  username!: string;
  password!: string | null;
  email!: string | null;
  expiry!: string | null;
  token!: string | null;
  updated!: string;
  is_deleted!: boolean;

  static typeChecker = {
    user_id: isString,
    username: isString,
    password: isNullableString,
    email: isNullableString,
    expiry: isNullableString,
    token: isNullableString,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, UserModel.typeChecker);
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
}

export const usersTable = createTable({
  name: USERS,
  primaryKey: USER_ID,
  schema: userSchema,
  ModelClass: UserModel,
});

export const userColumns = Object.keys(usersTable.schema);
