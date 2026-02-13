import { Products } from "plaid";
import {
  ItemStatus,
  ItemProvider,
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
