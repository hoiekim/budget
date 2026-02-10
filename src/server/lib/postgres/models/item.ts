/**
 * Item model and schema definition.
 */

import { Products } from "plaid";
import { ItemStatus, ItemProvider, JSONItem } from "common";
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
import {
  Schema,
  Constraints,
  PropertyChecker,
  AssertTypeFn,
  createAssertType,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  toDate,
  isArray,
  isNull,
} from "./base";

// =============================================
// Interfaces
// =============================================

/**
 * Item row as stored in the database.
 */
export interface ItemRow {
  item_id: string;
  user_id: string;
  access_token: string | null;
  institution_id: string | null;
  available_products: string[] | null;
  cursor: string | null;
  status: string | null;
  provider: string | null;
  raw: string | null;
  updated: Date | null;
  is_deleted: boolean | null;
  // Optional from JOIN
  username?: string | null;
}

// =============================================
// Model Class
// =============================================

export class ItemModel {
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

  constructor(row: ItemRow) {
    ItemModel.assertType(row);
    this.item_id = row.item_id;
    this.user_id = row.user_id;
    this.access_token = row.access_token || "no_access_token";
    this.institution_id = row.institution_id;
    this.available_products = (row.available_products as Products[]) || [];
    this.cursor = row.cursor ?? undefined;
    this.status = row.status ? (row.status as ItemStatus) : undefined;
    this.provider = (row.provider as ItemProvider) || ItemProvider.MANUAL;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  /**
   * Converts to JSONItem format.
   */
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

  /**
   * Creates an ItemRow from a JSONItem.
   */
  static fromJSON(item: Partial<JSONItem> & { item_id: string }, user_id: string): Partial<ItemRow> {
    const row: Partial<ItemRow> = {
      item_id: item.item_id,
      user_id,
    };

    if (item.access_token !== undefined) row.access_token = item.access_token;
    if (item.institution_id !== undefined) row.institution_id = item.institution_id || null;
    if (item.available_products !== undefined) row.available_products = item.available_products;
    if (item.cursor !== undefined) row.cursor = item.cursor ?? null;
    if (item.status !== undefined) row.status = item.status ?? null;
    if (item.provider !== undefined) row.provider = item.provider;
    
    // Store full object in raw
    row.raw = JSON.stringify(item);

    return row;
  }

  static assertType: AssertTypeFn<ItemRow> = createAssertType<ItemRow>("ItemModel", {
    item_id: isString,
    user_id: isString,
    access_token: isNullableString,
    institution_id: isNullableString,
    available_products: (v): v is string[] | null => isNull(v) || isArray(v),
    cursor: isNullableString,
    status: isNullableString,
    provider: isNullableString,
    raw: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
    username: isNullableString,
  } as PropertyChecker<ItemRow>);
}

// =============================================
// Schema Definition
// =============================================

export const itemSchema: Schema<ItemRow> = {
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

export const itemConstraints: Constraints = [];

export const itemColumns = Object.keys(itemSchema);

export const itemIndexes = [
  { table: ITEMS, column: USER_ID },
  { table: ITEMS, column: INSTITUTION_ID },
];
