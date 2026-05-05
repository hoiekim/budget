import { isString, isNullableString, isStringArray } from "common";
import {
  USER_ID,
  CREATED_AT,
  KEY_ID,
  KEY_HASH,
  KEY_PREFIX,
  SCOPES,
  NAME,
  LAST_USED_AT,
  REVOKED_AT,
  EXPIRES_AT,
  UPDATED,
  API_KEYS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

export interface ApiKeyJSON {
  key_id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

const apiKeySchema = {
  [KEY_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE",
  [NAME]: "VARCHAR(255) NOT NULL",
  [KEY_HASH]: "VARCHAR(64) UNIQUE NOT NULL",
  [KEY_PREFIX]: "VARCHAR(16) NOT NULL",
  [SCOPES]: "TEXT[] NOT NULL DEFAULT '{}'",
  [CREATED_AT]: "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP",
  [LAST_USED_AT]: "TIMESTAMPTZ",
  [REVOKED_AT]: "TIMESTAMPTZ",
  [EXPIRES_AT]: "TIMESTAMPTZ",
  // Framework-required: buildInsert/buildUpdate always touch this column.
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type ApiKeySchema = typeof apiKeySchema;
type ApiKeyRow = { [k in keyof ApiKeySchema]: RowValueType };

export class ApiKeyModel
  extends Model<ApiKeyJSON, ApiKeySchema>
  implements ApiKeyRow
{
  declare key_id: string;
  declare user_id: string;
  declare name: string;
  declare key_hash: string;
  declare key_prefix: string;
  declare scopes: string[];
  declare created_at: string;
  declare last_used_at: string | null;
  declare revoked_at: string | null;
  declare expires_at: string | null;

  static typeChecker = {
    key_id: isString,
    user_id: isString,
    name: isString,
    key_hash: isString,
    key_prefix: isString,
    scopes: isStringArray,
    created_at: isString,
    last_used_at: isNullableString,
    revoked_at: isNullableString,
    expires_at: isNullableString,
  };

  constructor(data: unknown) {
    super(data, ApiKeyModel.typeChecker);
  }

  toJSON(): ApiKeyJSON {
    return {
      key_id: this.key_id,
      user_id: this.user_id,
      name: this.name,
      key_prefix: this.key_prefix,
      scopes: this.scopes,
      created_at: this.created_at,
      last_used_at: this.last_used_at,
      revoked_at: this.revoked_at,
      expires_at: this.expires_at,
    };
  }
}

export const apiKeysTable = createTable({
  name: API_KEYS,
  primaryKey: KEY_ID,
  schema: apiKeySchema,
  indexes: [{ column: USER_ID }, { column: KEY_HASH }],
  ModelClass: ApiKeyModel,
  supportsSoftDelete: false,
});
