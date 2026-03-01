import { Products } from "plaid";
import {
  ItemStatus,
  ItemProvider,
  SyncStatus,
  JSONItem,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableObject,
  isNullableArray,
} from "common";
import {
  ITEM_ID,
  USER_ID,
  ACCESS_TOKEN,
  INSTITUTION_ID,
  AVAILABLE_PRODUCTS,
  CURSOR,
  STATUS,
  PROVIDER,
  LAST_SYNC_STATUS,
  LAST_SYNC_AT,
  LAST_SYNC_ERROR,
  RAW,
  UPDATED,
  IS_DELETED,
  ITEMS,
  USERS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const itemSchema = {
  [ITEM_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [ACCESS_TOKEN]: "VARCHAR(255)",
  [INSTITUTION_ID]: "VARCHAR(255)",
  [AVAILABLE_PRODUCTS]: "TEXT[]",
  [CURSOR]: "TEXT",
  [STATUS]: "VARCHAR(50)",
  [PROVIDER]: "VARCHAR(50)",
  [LAST_SYNC_STATUS]: "VARCHAR(20)",
  [LAST_SYNC_AT]: "TIMESTAMPTZ",
  [LAST_SYNC_ERROR]: "TEXT",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type ItemSchema = typeof itemSchema;
type ItemRow = { [k in keyof ItemSchema]: RowValueType };

export class ItemModel extends Model<JSONItem, ItemSchema> implements ItemRow {
  declare item_id: string;
  declare user_id: string;
  declare access_token: string;
  declare institution_id: string | null;
  declare available_products: Products[];
  declare cursor: string | null;
  declare status: ItemStatus | null;
  declare provider: ItemProvider;
  declare last_sync_status: SyncStatus | null;
  declare last_sync_at: string | null;
  declare last_sync_error: string | null;
  declare raw: object | null;
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    item_id: isString,
    user_id: isString,
    access_token: isNullableString,
    institution_id: isNullableString,
    available_products: isNullableArray,
    cursor: isNullableString,
    status: isNullableString,
    provider: isNullableString,
    last_sync_status: isNullableString,
    last_sync_at: isNullableString,
    last_sync_error: isNullableString,
    raw: isNullableObject,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, ItemModel.typeChecker);
  }

  toJSON(): JSONItem {
    return {
      item_id: this.item_id,
      access_token: this.access_token,
      institution_id: this.institution_id,
      available_products: this.available_products,
      cursor: this.cursor || undefined,
      status: this.status || undefined,
      provider: this.provider,
      updated: this.updated || undefined,
      last_sync_status: this.last_sync_status || undefined,
      last_sync_at: this.last_sync_at || undefined,
      last_sync_error: this.last_sync_error || undefined,
    };
  }

  static fromJSON(
    item: Partial<JSONItem> & { item_id: string },
    user_id: string,
  ): Partial<ItemRow> {
    const r: Partial<ItemRow> = { item_id: item.item_id, user_id };
    if (item.access_token !== undefined) r.access_token = item.access_token;
    if (item.institution_id !== undefined) r.institution_id = item.institution_id || null;
    if (item.available_products !== undefined) r.available_products = item.available_products;
    if (item.cursor !== undefined) r.cursor = item.cursor ?? null;
    if (item.status !== undefined) r.status = item.status ?? null;
    if (item.provider !== undefined) r.provider = item.provider;
    if (item.last_sync_status !== undefined) r.last_sync_status = item.last_sync_status ?? null;
    if (item.last_sync_at !== undefined) r.last_sync_at = item.last_sync_at ?? null;
    if (item.last_sync_error !== undefined) r.last_sync_error = item.last_sync_error ?? null;
    r.raw = item;
    return r;
  }
}

export const itemsTable = createTable({
  name: ITEMS,
  primaryKey: ITEM_ID,
  schema: itemSchema,
  indexes: [{ column: USER_ID }, { column: INSTITUTION_ID }],
  ModelClass: ItemModel,
});

export const itemColumns = Object.keys(itemsTable.schema);
