import {
  JSONAccountSnapshot, JSONSecuritySnapshot, JSONHoldingSnapshot, JSONSnapshotData, isString,
  isNullableString, isNullableNumber, isNullableNumericLike, isNullableBoolean, isNullableDate,
} from "common";
import {
  SNAPSHOT_ID, USER_ID, SNAPSHOT_DATE, SNAPSHOT_TYPE, ACCOUNT_ID, SECURITY_ID,
  BALANCES_AVAILABLE, BALANCES_CURRENT, BALANCES_LIMIT, BALANCES_ISO_CURRENCY_CODE,
  CLOSE_PRICE, HOLDING_ACCOUNT_ID, HOLDING_SECURITY_ID, INSTITUTION_PRICE,
  INSTITUTION_VALUE, COST_BASIS, QUANTITY, UPDATED, IS_DELETED, SNAPSHOTS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";
import { toDate, toNullableNumber, toISOString } from "../util";

export type SnapshotType = "account_balance" | "security" | "holding";

export class SnapshotModel extends Model<JSONSnapshotData> {
  snapshot_id: string; user_id: string | null; snapshot_date: string; snapshot_type: SnapshotType;
  account_id: string | null; balances_available: number | null; balances_current: number | null;
  balances_limit: number | null; balances_iso_currency_code: string | null;
  security_id: string | null; close_price: number | null;
  holding_account_id: string | null; holding_security_id: string | null;
  institution_price: number | null; institution_value: number | null;
  cost_basis: number | null; quantity: number | null; updated: Date; is_deleted: boolean;

  constructor(data: unknown) {
    super();
    SnapshotModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.snapshot_id = r.snapshot_id as string;
    this.user_id = (r.user_id as string) ?? null;
    this.snapshot_date = toISOString(r.snapshot_date);
    this.snapshot_type = r.snapshot_type as SnapshotType;
    this.account_id = (r.account_id as string) ?? null;
    this.balances_available = toNullableNumber(r.balances_available);
    this.balances_current = toNullableNumber(r.balances_current);
    this.balances_limit = toNullableNumber(r.balances_limit);
    this.balances_iso_currency_code = (r.balances_iso_currency_code as string) ?? null;
    this.security_id = (r.security_id as string) ?? null;
    this.close_price = toNullableNumber(r.close_price);
    this.holding_account_id = (r.holding_account_id as string) ?? null;
    this.holding_security_id = (r.holding_security_id as string) ?? null;
    this.institution_price = toNullableNumber(r.institution_price);
    this.institution_value = toNullableNumber(r.institution_value);
    this.cost_basis = toNullableNumber(r.cost_basis);
    this.quantity = toNullableNumber(r.quantity);
    this.updated = r.updated ? toDate(r.updated) : new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
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

  static fromAccountSnapshot(d: JSONAccountSnapshot, user_id: string): Record<string, unknown> {
    return {
      snapshot_id: d.snapshot.snapshot_id, user_id, snapshot_date: d.snapshot.date,
      snapshot_type: "account_balance", account_id: d.account.account_id,
      balances_available: d.account.balances?.available ?? null,
      balances_current: d.account.balances?.current ?? null,
      balances_limit: d.account.balances?.limit ?? null,
      balances_iso_currency_code: d.account.balances?.iso_currency_code ?? null,
    };
  }

  static fromSecuritySnapshot(d: JSONSecuritySnapshot): Record<string, unknown> {
    return {
      snapshot_id: d.snapshot.snapshot_id, snapshot_date: d.snapshot.date,
      snapshot_type: "security", security_id: d.security.security_id,
      close_price: d.security.close_price ?? null,
    };
  }

  static fromHoldingSnapshot(d: JSONHoldingSnapshot, user_id: string): Record<string, unknown> {
    return {
      snapshot_id: d.snapshot.snapshot_id, user_id, snapshot_date: d.snapshot.date,
      snapshot_type: "holding", holding_account_id: d.holding.account_id,
      holding_security_id: d.holding.security_id,
      institution_price: d.holding.institution_price ?? null,
      institution_value: d.holding.institution_value ?? null,
      cost_basis: d.holding.cost_basis ?? null, quantity: d.holding.quantity ?? null,
    };
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SnapshotModel", {
    snapshot_id: isString, user_id: isNullableString, snapshot_date: isNullableDate, snapshot_type: isString,
    account_id: isNullableString, balances_available: isNullableNumericLike, balances_current: isNullableNumericLike,
    balances_limit: isNullableNumericLike, balances_iso_currency_code: isNullableString, security_id: isNullableString,
    close_price: isNullableNumericLike, holding_account_id: isNullableString, holding_security_id: isNullableString,
    institution_price: isNullableNumericLike, institution_value: isNullableNumericLike, cost_basis: isNullableNumericLike,
    quantity: isNullableNumericLike, updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export const snapshotsTable = createTable({
  name: SNAPSHOTS,
  schema: {
    [SNAPSHOT_ID]: "VARCHAR(255) PRIMARY KEY", [USER_ID]: "UUID",
    [SNAPSHOT_DATE]: "TIMESTAMPTZ NOT NULL", [SNAPSHOT_TYPE]: "VARCHAR(50) NOT NULL",
    [ACCOUNT_ID]: "VARCHAR(255)", [BALANCES_AVAILABLE]: "DECIMAL(15, 2)", [BALANCES_CURRENT]: "DECIMAL(15, 2)",
    [BALANCES_LIMIT]: "DECIMAL(15, 2)", [BALANCES_ISO_CURRENCY_CODE]: "VARCHAR(10)",
    [SECURITY_ID]: "VARCHAR(255)", [CLOSE_PRICE]: "DECIMAL(15, 6)",
    [HOLDING_ACCOUNT_ID]: "VARCHAR(255)", [HOLDING_SECURITY_ID]: "VARCHAR(255)",
    [INSTITUTION_PRICE]: "DECIMAL(15, 6)", [INSTITUTION_VALUE]: "DECIMAL(15, 2)",
    [COST_BASIS]: "DECIMAL(15, 2)", [QUANTITY]: "DECIMAL(15, 6)",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [
    { column: USER_ID }, { column: SNAPSHOT_TYPE }, { column: SNAPSHOT_DATE },
    { column: ACCOUNT_ID }, { column: SECURITY_ID },
  ],
  ModelClass: SnapshotModel,
});

export const snapshotColumns = Object.keys(snapshotsTable.schema);

export const isAccountSnapshot = (d: JSONSnapshotData): d is JSONAccountSnapshot => "account" in d;
export const isSecuritySnapshot = (d: JSONSnapshotData): d is JSONSecuritySnapshot => "security" in d;
export const isHoldingSnapshot = (d: JSONSnapshotData): d is JSONHoldingSnapshot => "holding" in d;
