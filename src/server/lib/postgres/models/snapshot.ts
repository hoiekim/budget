import {
  JSONAccountSnapshot,
  JSONSecuritySnapshot,
  JSONHoldingSnapshot,
  JSONSnapshotData,
  isString,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
  isNullableDate,
} from "common";
import {
  SNAPSHOT_ID, USER_ID, SNAPSHOT_DATE, SNAPSHOT_TYPE, ACCOUNT_ID, SECURITY_ID,
  BALANCES_AVAILABLE, BALANCES_CURRENT, BALANCES_LIMIT, BALANCES_ISO_CURRENCY_CODE,
  CLOSE_PRICE, HOLDING_ACCOUNT_ID, HOLDING_SECURITY_ID, INSTITUTION_PRICE,
  INSTITUTION_VALUE, COST_BASIS, QUANTITY, UPDATED, IS_DELETED, SNAPSHOTS,
} from "./common";
import { Schema, Constraints, IndexDefinition, Table, AssertTypeFn, createAssertType, Model } from "./base";
import { toDate, toNullableNumber, toISOString } from "../util";

export type SnapshotType = "account_balance" | "security" | "holding";

export class SnapshotModel extends Model<JSONSnapshotData> {
  snapshot_id: string;
  user_id: string | null;
  snapshot_date: string;
  snapshot_type: SnapshotType;
  account_id: string | null;
  balances_available: number | null;
  balances_current: number | null;
  balances_limit: number | null;
  balances_iso_currency_code: string | null;
  security_id: string | null;
  close_price: number | null;
  holding_account_id: string | null;
  holding_security_id: string | null;
  institution_price: number | null;
  institution_value: number | null;
  cost_basis: number | null;
  quantity: number | null;
  updated: Date;
  is_deleted: boolean;

  constructor(data: unknown) {
    super();
    SnapshotModel.assertType(data);
    const row = data as Record<string, unknown>;
    this.snapshot_id = row.snapshot_id as string;
    this.user_id = (row.user_id as string) ?? null;
    this.snapshot_date = toISOString(row.snapshot_date);
    this.snapshot_type = row.snapshot_type as SnapshotType;
    this.account_id = (row.account_id as string) ?? null;
    this.balances_available = toNullableNumber(row.balances_available);
    this.balances_current = toNullableNumber(row.balances_current);
    this.balances_limit = toNullableNumber(row.balances_limit);
    this.balances_iso_currency_code = (row.balances_iso_currency_code as string) ?? null;
    this.security_id = (row.security_id as string) ?? null;
    this.close_price = toNullableNumber(row.close_price);
    this.holding_account_id = (row.holding_account_id as string) ?? null;
    this.holding_security_id = (row.holding_security_id as string) ?? null;
    this.institution_price = toNullableNumber(row.institution_price);
    this.institution_value = toNullableNumber(row.institution_value);
    this.cost_basis = toNullableNumber(row.cost_basis);
    this.quantity = toNullableNumber(row.quantity);
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONSnapshotData {
    switch (this.snapshot_type) {
      case "account_balance": return this.toAccountSnapshot();
      case "security": return this.toSecuritySnapshot();
      case "holding": return this.toHoldingSnapshot();
    }
  }

  toAccountSnapshot(): JSONAccountSnapshot {
    return {
      snapshot: { snapshot_id: this.snapshot_id, date: this.snapshot_date },
      user: { user_id: this.user_id ?? "" },
      account: {
        account_id: this.account_id ?? "",
        balances: {
          current: this.balances_current, available: this.balances_available,
          limit: this.balances_limit, iso_currency_code: this.balances_iso_currency_code,
          unofficial_currency_code: null,
        },
      },
    } as JSONAccountSnapshot;
  }

  toSecuritySnapshot(): JSONSecuritySnapshot {
    return {
      snapshot: { snapshot_id: this.snapshot_id, date: this.snapshot_date },
      security: { security_id: this.security_id ?? "", close_price: this.close_price },
    } as JSONSecuritySnapshot;
  }

  toHoldingSnapshot(): JSONHoldingSnapshot {
    return {
      snapshot: { snapshot_id: this.snapshot_id, date: this.snapshot_date },
      user: { user_id: this.user_id ?? "" },
      holding: {
        account_id: this.holding_account_id ?? "", security_id: this.holding_security_id ?? "",
        institution_price: this.institution_price ?? 0, institution_value: this.institution_value ?? 0,
        cost_basis: this.cost_basis ?? 0, quantity: this.quantity ?? 0,
      },
    } as JSONHoldingSnapshot;
  }

  static fromAccountSnapshot(data: JSONAccountSnapshot, user_id: string): Record<string, unknown> {
    return {
      snapshot_id: data.snapshot.snapshot_id, user_id, snapshot_date: data.snapshot.date,
      snapshot_type: "account_balance", account_id: data.account.account_id,
      balances_available: data.account.balances?.available ?? null,
      balances_current: data.account.balances?.current ?? null,
      balances_limit: data.account.balances?.limit ?? null,
      balances_iso_currency_code: data.account.balances?.iso_currency_code ?? null,
    };
  }

  static fromSecuritySnapshot(data: JSONSecuritySnapshot): Record<string, unknown> {
    return {
      snapshot_id: data.snapshot.snapshot_id, snapshot_date: data.snapshot.date,
      snapshot_type: "security", security_id: data.security.security_id,
      close_price: data.security.close_price ?? null,
    };
  }

  static fromHoldingSnapshot(data: JSONHoldingSnapshot, user_id: string): Record<string, unknown> {
    return {
      snapshot_id: data.snapshot.snapshot_id, user_id, snapshot_date: data.snapshot.date,
      snapshot_type: "holding", holding_account_id: data.holding.account_id,
      holding_security_id: data.holding.security_id,
      institution_price: data.holding.institution_price ?? null,
      institution_value: data.holding.institution_value ?? null,
      cost_basis: data.holding.cost_basis ?? null, quantity: data.holding.quantity ?? null,
    };
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SnapshotModel", {
    snapshot_id: isString, user_id: isNullableString, snapshot_date: isNullableDate, snapshot_type: isString,
    account_id: isNullableString, balances_available: isNullableNumber, balances_current: isNullableNumber,
    balances_limit: isNullableNumber, balances_iso_currency_code: isNullableString, security_id: isNullableString,
    close_price: isNullableNumber, holding_account_id: isNullableString, holding_security_id: isNullableString,
    institution_price: isNullableNumber, institution_value: isNullableNumber, cost_basis: isNullableNumber,
    quantity: isNullableNumber, updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export class SnapshotsTable extends Table<JSONSnapshotData, SnapshotModel> {
  readonly name = SNAPSHOTS;
  readonly schema: Schema<Record<string, unknown>> = {
    [SNAPSHOT_ID]: "VARCHAR(255) PRIMARY KEY", [USER_ID]: "UUID",
    [SNAPSHOT_DATE]: "TIMESTAMPTZ NOT NULL", [SNAPSHOT_TYPE]: "VARCHAR(50) NOT NULL",
    [ACCOUNT_ID]: "VARCHAR(255)", [BALANCES_AVAILABLE]: "DECIMAL(15, 2)", [BALANCES_CURRENT]: "DECIMAL(15, 2)",
    [BALANCES_LIMIT]: "DECIMAL(15, 2)", [BALANCES_ISO_CURRENCY_CODE]: "VARCHAR(10)",
    [SECURITY_ID]: "VARCHAR(255)", [CLOSE_PRICE]: "DECIMAL(15, 6)",
    [HOLDING_ACCOUNT_ID]: "VARCHAR(255)", [HOLDING_SECURITY_ID]: "VARCHAR(255)",
    [INSTITUTION_PRICE]: "DECIMAL(15, 6)", [INSTITUTION_VALUE]: "DECIMAL(15, 2)",
    [COST_BASIS]: "DECIMAL(15, 2)", [QUANTITY]: "DECIMAL(15, 6)",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  };
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [
    { column: USER_ID }, { column: SNAPSHOT_TYPE }, { column: SNAPSHOT_DATE },
    { column: ACCOUNT_ID }, { column: SECURITY_ID },
  ];
  readonly ModelClass = SnapshotModel;
}

export const snapshotsTable = new SnapshotsTable();
export const snapshotColumns = Object.keys(snapshotsTable.schema);

export function isAccountSnapshot(data: JSONSnapshotData): data is JSONAccountSnapshot {
  return "account" in data;
}
export function isSecuritySnapshot(data: JSONSnapshotData): data is JSONSecuritySnapshot {
  return "security" in data;
}
export function isHoldingSnapshot(data: JSONSnapshotData): data is JSONHoldingSnapshot {
  return "holding" in data;
}
