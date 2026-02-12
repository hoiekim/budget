import { Products } from "plaid";
import {
  ItemStatus, ItemProvider, JSONItem, isString, isNullableString,
  isNullableBoolean, isNullableDate, isNullableObject, isNullableArray,
} from "common";
import {
  ITEM_ID, USER_ID, ACCESS_TOKEN, INSTITUTION_ID, AVAILABLE_PRODUCTS,
  CURSOR, STATUS, PROVIDER, RAW, UPDATED, IS_DELETED, ITEMS, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

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
    const r = data as Record<string, unknown>;
    this.item_id = r.item_id as string;
    this.user_id = r.user_id as string;
    this.access_token = (r.access_token as string) || "no_access_token";
    this.institution_id = (r.institution_id as string) ?? null;
    this.available_products = (r.available_products as Products[]) || [];
    this.cursor = (r.cursor as string) ?? undefined;
    this.status = r.status ? (r.status as ItemStatus) : undefined;
    this.provider = (r.provider as ItemProvider) || ItemProvider.MANUAL;
    this.updated = (r.updated as Date) ?? new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
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

  static toRow(item: Partial<JSONItem> & { item_id: string }, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { item_id: item.item_id, user_id };
    if (item.access_token !== undefined) r.access_token = item.access_token;
    if (item.institution_id !== undefined) r.institution_id = item.institution_id || null;
    if (item.available_products !== undefined) r.available_products = item.available_products;
    if (item.cursor !== undefined) r.cursor = item.cursor ?? null;
    if (item.status !== undefined) r.status = item.status ?? null;
    if (item.provider !== undefined) r.provider = item.provider;
    r.raw = item;
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("ItemModel", {
    item_id: isString,
    user_id: isString,
    access_token: isNullableString,
    institution_id: isNullableString,
    available_products: isNullableArray,
    cursor: isNullableString,
    status: isNullableString,
    provider: isNullableString,
    raw: isNullableObject,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export const itemsTable = createTable({
  name: ITEMS,
  primaryKey: ITEM_ID,
  schema: {
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
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: INSTITUTION_ID }],
  ModelClass: ItemModel,
});

export const itemColumns = Object.keys(itemsTable.schema);
