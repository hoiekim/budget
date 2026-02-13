import {
  JSONAccountSnapshot,
  JSONSecuritySnapshot,
  JSONHoldingSnapshot,
  JSONSnapshotData,
  isString,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
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
import { Model, RowValueType, createTable } from "./base";

export type SnapshotType = "account_balance" | "security" | "holding";

const snapshotSchema = {
  [SNAPSHOT_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: "UUID",
  [SNAPSHOT_DATE]: "TIMESTAMPTZ NOT NULL",
  [SNAPSHOT_TYPE]: "VARCHAR(50) NOT NULL",
  [ACCOUNT_ID]: "VARCHAR(255)",
  [BALANCES_AVAILABLE]: "DECIMAL(15, 2)",
  [BALANCES_CURRENT]: "DECIMAL(15, 2)",
  [BALANCES_LIMIT]: "DECIMAL(15, 2)",
  [BALANCES_ISO_CURRENCY_CODE]: "VARCHAR(10)",
  [SECURITY_ID]: "VARCHAR(255)",
  [CLOSE_PRICE]: "DECIMAL(15, 6)",
  [HOLDING_ACCOUNT_ID]: "VARCHAR(255)",
  [HOLDING_SECURITY_ID]: "VARCHAR(255)",
  [INSTITUTION_PRICE]: "DECIMAL(15, 6)",
  [INSTITUTION_VALUE]: "DECIMAL(15, 2)",
  [COST_BASIS]: "DECIMAL(15, 2)",
  [QUANTITY]: "DECIMAL(15, 6)",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type SnapshotSchema = typeof snapshotSchema;
type SnapshotRow = { [k in keyof SnapshotSchema]: RowValueType };

export class SnapshotModel extends Model<JSONSnapshotData, SnapshotSchema> implements SnapshotRow {
  declare snapshot_id: string;
  declare user_id: string | null;
  declare snapshot_date: string;
  declare snapshot_type: SnapshotType;
  declare account_id: string | null;
  declare balances_available: number | null;
  declare balances_current: number | null;
  declare balances_limit: number | null;
  declare balances_iso_currency_code: string | null;
  declare security_id: string | null;
  declare close_price: number | null;
  declare holding_account_id: string | null;
  declare holding_security_id: string | null;
  declare institution_price: number | null;
  declare institution_value: number | null;
  declare cost_basis: number | null;
  declare quantity: number | null;
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    snapshot_id: isString,
    user_id: isNullableString,
    snapshot_date: isString,
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
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, SnapshotModel.typeChecker);
  }

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
      snapshot: { snapshot_id: this.snapshot_id, date: this.snapshot_date },
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
      snapshot: { snapshot_id: this.snapshot_id, date: this.snapshot_date },
      security: { security_id: this.security_id ?? "", close_price: this.close_price },
    } as JSONSecuritySnapshot;
  }

  toHoldingSnapshot(): JSONHoldingSnapshot {
    return {
      snapshot: { snapshot_id: this.snapshot_id, date: this.snapshot_date },
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

  static fromAccountSnapshot(d: JSONAccountSnapshot, user_id: string): Partial<SnapshotRow> {
    return {
      snapshot_id: d.snapshot.snapshot_id,
      user_id,
      snapshot_date: d.snapshot.date,
      snapshot_type: "account_balance",
      account_id: d.account.account_id,
      balances_available: d.account.balances?.available ?? null,
      balances_current: d.account.balances?.current ?? null,
      balances_limit: d.account.balances?.limit ?? null,
      balances_iso_currency_code: d.account.balances?.iso_currency_code ?? null,
    };
  }

  static fromSecuritySnapshot(d: JSONSecuritySnapshot): Partial<SnapshotRow> {
    return {
      snapshot_id: d.snapshot.snapshot_id,
      snapshot_date: d.snapshot.date,
      snapshot_type: "security",
      security_id: d.security.security_id,
      close_price: d.security.close_price ?? null,
    };
  }

  static fromHoldingSnapshot(d: JSONHoldingSnapshot, user_id: string): Partial<SnapshotRow> {
    return {
      snapshot_id: d.snapshot.snapshot_id,
      user_id,
      snapshot_date: d.snapshot.date,
      snapshot_type: "holding",
      holding_account_id: d.holding.account_id,
      holding_security_id: d.holding.security_id,
      institution_price: d.holding.institution_price ?? null,
      institution_value: d.holding.institution_value ?? null,
      cost_basis: d.holding.cost_basis ?? null,
      quantity: d.holding.quantity ?? null,
    };
  }
}

export const snapshotsTable = createTable({
  name: SNAPSHOTS,
  primaryKey: SNAPSHOT_ID,
  schema: snapshotSchema,
  indexes: [
    { column: USER_ID },
    { column: SNAPSHOT_TYPE },
    { column: SNAPSHOT_DATE },
    { column: ACCOUNT_ID },
    { column: SECURITY_ID },
  ],
  ModelClass: SnapshotModel,
});

export const snapshotColumns = Object.keys(snapshotsTable.schema);

export const isAccountSnapshot = (d: JSONSnapshotData): d is JSONAccountSnapshot => "account" in d;
export const isSecuritySnapshot = (d: JSONSnapshotData): d is JSONSecuritySnapshot =>
  "security" in d;
export const isHoldingSnapshot = (d: JSONSnapshotData): d is JSONHoldingSnapshot => "holding" in d;
