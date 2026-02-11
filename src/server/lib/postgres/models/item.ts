import { Products } from "plaid";
import {
  ItemStatus,
  ItemProvider,
  JSONItem,
  isString,
  isArray,
  isNull,
  isUndefined,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  isNullableObject,
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
import { Schema, Constraints, IndexDefinition, Table, AssertTypeFn, createAssertType, Model } from "./base";
import { toDate } from "../util";

export class ItemModel extends Model<JSONItem> {
  item_id: string;
  user_id: string;
  access_token: string;
  institution_id: string | null;
  available_products: Products[];
  cursor: string | undefined;
  status: ItemStatus | undefined;
  provider: ItemProvider;
  updated: Date;
  is_deleted: boolean;

  constructor(data: unknown) {
    super();
    ItemModel.assertType(data);
    const row = data as Record<string, unknown>;
    this.item_id = row.item_id as string;
    this.user_id = row.user_id as string;
    this.access_token = (row.access_token as string) || "no_access_token";
    this.institution_id = (row.institution_id as string) ?? null;
    this.available_products = (row.available_products as Products[]) || [];
    this.cursor = (row.cursor as string) ?? undefined;
    this.status = row.status ? (row.status as ItemStatus) : undefined;
    this.provider = (row.provider as ItemProvider) || ItemProvider.MANUAL;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONItem {
    return {
      item_id: this.item_id,
      access_token: this.access_token,
      institution_id: this.institution_id,
      available_products: this.available_products,
      cursor: this.cursor,
      status: this.status,
      provider: this.provider,
      updated: this.updated.toISOString(),
    };
  }

  static fromJSON(item: Partial<JSONItem> & { item_id: string }, user_id: string): Record<string, unknown> {
    const row: Record<string, unknown> = {
      item_id: item.item_id,
      user_id,
    };
    if (item.access_token !== undefined) row.access_token = item.access_token;
    if (item.institution_id !== undefined) row.institution_id = item.institution_id || null;
    if (item.available_products !== undefined) row.available_products = item.available_products;
    if (item.cursor !== undefined) row.cursor = item.cursor ?? null;
    if (item.status !== undefined) row.status = item.status ?? null;
    if (item.provider !== undefined) row.provider = item.provider;
    row.raw = item;
    return row;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("ItemModel", {
    item_id: isString,
    user_id: isString,
    access_token: isNullableString,
    institution_id: isNullableString,
    available_products: (v): v is unknown => isUndefined(v) || isNull(v) || isArray(v),
    cursor: isNullableString,
    status: isNullableString,
    provider: isNullableString,
    raw: isNullableObject,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
    username: isNullableString,
  });
}

export class ItemsTable extends Table<JSONItem, ItemModel> {
  readonly name = ITEMS;
  readonly schema: Schema<Record<string, unknown>> = {
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
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [{ column: USER_ID }, { column: INSTITUTION_ID }];
  readonly ModelClass = ItemModel;
}

export const itemsTable = new ItemsTable();
export const itemColumns = Object.keys(itemsTable.schema);
