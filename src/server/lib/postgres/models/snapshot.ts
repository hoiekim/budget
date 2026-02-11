/**
 * Snapshot models and schema definitions.
 * Supports account, security, and holding snapshots.
 */

import {
  JSONAccountSnapshot,
  JSONSecuritySnapshot,
  JSONHoldingSnapshot,
  JSONSnapshotData,
  isString,
} from "common";
import {
  SNAPSHOT_ID,
  USER_ID,
  SNAPSHOT_DATE,
  SNAPSHOT_TYPE,
  ACCOUNT_ID,
  SECURITY_ID,
  BALANCES_AVAILABLE,
  BALANCES_CURRENT,
  BALANCES_LIMIT,
  BALANCES_ISO_CURRENCY_CODE,
  CLOSE_PRICE,
  HOLDING_ACCOUNT_ID,
  HOLDING_SECURITY_ID,
  INSTITUTION_PRICE,
  INSTITUTION_VALUE,
  COST_BASIS,
  QUANTITY,
  UPDATED,
  IS_DELETED,
  SNAPSHOTS,
} from "./common";
import {
  Schema,
  Constraints,
  TableDefinition,
  AssertTypeFn,
  createAssertType,
  Model,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
  isNullableDate,
  toDate,
  toNullableNumber,
  toISOString,
} from "./base";

// Snapshot Types

export type SnapshotType = "account_balance" | "security" | "holding";

// Snapshot Row Interface

export interface SnapshotRow {
  snapshot_id: string;
  user_id: string | null | undefined;
  snapshot_date: Date | string;
  snapshot_type: SnapshotType;
  // Account balance fields
  account_id: string | null | undefined;
  balances_available: string | number | null | undefined;
  balances_current: string | number | null | undefined;
  balances_limit: string | number | null | undefined;
  balances_iso_currency_code: string | null | undefined;
  // Security fields
  security_id: string | null | undefined;
  close_price: string | number | null | undefined;
  // Holding fields
  holding_account_id: string | null | undefined;
  holding_security_id: string | null | undefined;
  institution_price: string | number | null | undefined;
  institution_value: string | number | null | undefined;
  cost_basis: string | number | null | undefined;
  quantity: string | number | null | undefined;
  // Metadata
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

// Snapshot Model Class

export class SnapshotModel extends Model<SnapshotRow, JSONSnapshotData> {
  snapshot_id: string;
  user_id: string | null;
  snapshot_date: string;
  snapshot_type: SnapshotType;
  // Account balance fields
  account_id: string | null;
  balances_available: number | null;
  balances_current: number | null;
  balances_limit: number | null;
  balances_iso_currency_code: string | null;
  // Security fields
  security_id: string | null;
  close_price: number | null;
  // Holding fields
  holding_account_id: string | null;
  holding_security_id: string | null;
  institution_price: number | null;
  institution_value: number | null;
  cost_basis: number | null;
  quantity: number | null;
  // Metadata
  updated: Date;
  is_deleted: boolean;

  constructor(row: SnapshotRow) {
    super();
    SnapshotModel.assertType(row);
    this.snapshot_id = row.snapshot_id;
    this.user_id = row.user_id ?? null;
    this.snapshot_date = toISOString(row.snapshot_date);
    this.snapshot_type = row.snapshot_type;
    this.account_id = row.account_id ?? null;
    this.balances_available = toNullableNumber(row.balances_available);
    this.balances_current = toNullableNumber(row.balances_current);
    this.balances_limit = toNullableNumber(row.balances_limit);
    this.balances_iso_currency_code = row.balances_iso_currency_code ?? null;
    this.security_id = row.security_id ?? null;
    this.close_price = toNullableNumber(row.close_price);
    this.holding_account_id = row.holding_account_id ?? null;
    this.holding_security_id = row.holding_security_id ?? null;
    this.institution_price = toNullableNumber(row.institution_price);
    this.institution_value = toNullableNumber(row.institution_value);
    this.cost_basis = toNullableNumber(row.cost_basis);
    this.quantity = toNullableNumber(row.quantity);
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  /**
   * Converts to the appropriate JSON snapshot format based on type.
   */
  toJSON(): JSONSnapshotData {
    switch (this.snapshot_type) {
      case "account_balance":
        return this.toAccountSnapshot();
      case "security":
        return this.toSecuritySnapshot();
      case "holding":
        return this.toHoldingSnapshot();
    }
  }

  toAccountSnapshot(): JSONAccountSnapshot {
    return {
      snapshot: {
        snapshot_id: this.snapshot_id,
        date: this.snapshot_date,
      },
      user: { user_id: this.user_id ?? "" },
      account: {
        account_id: this.account_id ?? "",
        balances: {
          current: this.balances_current,
          available: this.balances_available,
          limit: this.balances_limit,
          iso_currency_code: this.balances_iso_currency_code,
          unofficial_currency_code: null,
        },
      },
    } as JSONAccountSnapshot;
  }

  toSecuritySnapshot(): JSONSecuritySnapshot {
    return {
      snapshot: {
        snapshot_id: this.snapshot_id,
        date: this.snapshot_date,
      },
      security: {
        security_id: this.security_id ?? "",
        close_price: this.close_price,
      },
    } as JSONSecuritySnapshot;
  }

  toHoldingSnapshot(): JSONHoldingSnapshot {
    return {
      snapshot: {
        snapshot_id: this.snapshot_id,
        date: this.snapshot_date,
      },
      user: { user_id: this.user_id ?? "" },
      holding: {
        account_id: this.holding_account_id ?? "",
        security_id: this.holding_security_id ?? "",
        institution_price: this.institution_price ?? 0,
        institution_value: this.institution_value ?? 0,
        cost_basis: this.cost_basis ?? 0,
        quantity: this.quantity ?? 0,
      },
    } as JSONHoldingSnapshot;
  }

  /**
   * Creates a SnapshotRow from JSONAccountSnapshot.
   */
  static fromAccountSnapshot(
    data: JSONAccountSnapshot,
    user_id: string
  ): Partial<SnapshotRow> {
    return {
      snapshot_id: data.snapshot.snapshot_id,
      user_id,
      snapshot_date: data.snapshot.date,
      snapshot_type: "account_balance",
      account_id: data.account.account_id,
      balances_available: data.account.balances?.available ?? null,
      balances_current: data.account.balances?.current ?? null,
      balances_limit: data.account.balances?.limit ?? null,
      balances_iso_currency_code: data.account.balances?.iso_currency_code ?? null,
    };
  }

  /**
   * Creates a SnapshotRow from JSONSecuritySnapshot.
   */
  static fromSecuritySnapshot(data: JSONSecuritySnapshot): Partial<SnapshotRow> {
    return {
      snapshot_id: data.snapshot.snapshot_id,
      snapshot_date: data.snapshot.date,
      snapshot_type: "security",
      security_id: data.security.security_id,
      close_price: data.security.close_price ?? null,
    };
  }

  /**
   * Creates a SnapshotRow from JSONHoldingSnapshot.
   */
  static fromHoldingSnapshot(
    data: JSONHoldingSnapshot,
    user_id: string
  ): Partial<SnapshotRow> {
    return {
      snapshot_id: data.snapshot.snapshot_id,
      user_id,
      snapshot_date: data.snapshot.date,
      snapshot_type: "holding",
      holding_account_id: data.holding.account_id,
      holding_security_id: data.holding.security_id,
      institution_price: data.holding.institution_price ?? null,
      institution_value: data.holding.institution_value ?? null,
      cost_basis: data.holding.cost_basis ?? null,
      quantity: data.holding.quantity ?? null,
    };
  }

  static assertType: AssertTypeFn<SnapshotRow> = createAssertType<SnapshotRow>("SnapshotModel", {
    snapshot_id: isString,
    user_id: isNullableString,
    snapshot_date: isNullableDate,
    snapshot_type: isString,
    account_id: isNullableString,
    balances_available: isNullableNumber,
    balances_current: isNullableNumber,
    balances_limit: isNullableNumber,
    balances_iso_currency_code: isNullableString,
    security_id: isNullableString,
    close_price: isNullableNumber,
    holding_account_id: isNullableString,
    holding_security_id: isNullableString,
    institution_price: isNullableNumber,
    institution_value: isNullableNumber,
    cost_basis: isNullableNumber,
    quantity: isNullableNumber,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

// Snapshot Schema

export const snapshotSchema: Schema<SnapshotRow> = {
  [SNAPSHOT_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: "UUID",
  [SNAPSHOT_DATE]: "TIMESTAMPTZ NOT NULL",
  [SNAPSHOT_TYPE]: "VARCHAR(50) NOT NULL",
  // Account balance fields
  [ACCOUNT_ID]: "VARCHAR(255)",
  [BALANCES_AVAILABLE]: "DECIMAL(15, 2)",
  [BALANCES_CURRENT]: "DECIMAL(15, 2)",
  [BALANCES_LIMIT]: "DECIMAL(15, 2)",
  [BALANCES_ISO_CURRENCY_CODE]: "VARCHAR(10)",
  // Security fields
  [SECURITY_ID]: "VARCHAR(255)",
  [CLOSE_PRICE]: "DECIMAL(15, 6)",
  // Holding fields
  [HOLDING_ACCOUNT_ID]: "VARCHAR(255)",
  [HOLDING_SECURITY_ID]: "VARCHAR(255)",
  [INSTITUTION_PRICE]: "DECIMAL(15, 6)",
  [INSTITUTION_VALUE]: "DECIMAL(15, 2)",
  [COST_BASIS]: "DECIMAL(15, 2)",
  [QUANTITY]: "DECIMAL(15, 6)",
  // Metadata
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const snapshotConstraints: Constraints = [];

export const snapshotColumns = Object.keys(snapshotSchema);

export const snapshotIndexes = [
  { column: USER_ID },
  { column: SNAPSHOT_TYPE },
  { column: SNAPSHOT_DATE },
  { column: ACCOUNT_ID },
  { column: SECURITY_ID },
];

export const snapshotTable: TableDefinition = {
  name: SNAPSHOTS,
  schema: snapshotSchema as Schema<Record<string, unknown>>,
  constraints: snapshotConstraints,
  indexes: snapshotIndexes,
};

export function isAccountSnapshot(
  data: JSONSnapshotData
): data is JSONAccountSnapshot {
  return "account" in data;
}

export function isSecuritySnapshot(
  data: JSONSnapshotData
): data is JSONSecuritySnapshot {
  return "security" in data;
}

export function isHoldingSnapshot(
  data: JSONSnapshotData
): data is JSONHoldingSnapshot {
  return "holding" in data;
}
