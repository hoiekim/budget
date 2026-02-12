import { AccountType, AccountSubtype } from "plaid";
import {
  JSONAccount,
  isString,
  isUndefined,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
  isNullableObject,
} from "common";
import {
  ACCOUNT_ID,
  USER_ID,
  ITEM_ID,
  INSTITUTION_ID,
  NAME,
  TYPE,
  SUBTYPE,
  BALANCES_AVAILABLE,
  BALANCES_CURRENT,
  BALANCES_LIMIT,
  BALANCES_ISO_CURRENCY_CODE,
  CUSTOM_NAME,
  HIDE,
  LABEL_BUDGET_ID,
  GRAPH_OPTIONS_USE_SNAPSHOTS,
  GRAPH_OPTIONS_USE_TRANSACTIONS,
  RAW,
  UPDATED,
  IS_DELETED,
  ACCOUNTS,
  USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class AccountModel extends Model<JSONAccount> {
  account_id!: string;
  user_id!: string;
  item_id!: string;
  institution_id!: string;
  name!: string;
  type!: AccountType;
  subtype!: AccountSubtype | null;
  balances_available!: number;
  balances_current!: number;
  balances_limit!: number;
  balances_iso_currency_code!: string;
  custom_name!: string;
  hide!: boolean;
  label_budget_id!: string | null;
  graph_options_use_snapshots!: boolean;
  graph_options_use_transactions!: boolean;
  updated!: string | null;
  is_deleted!: boolean;

  static typeChecker = {
    account_id: isString,
    user_id: isString,
    item_id: isString,
    institution_id: isString,
    name: isNullableString,
    type: isNullableString,
    subtype: isNullableString,
    balances_available: isNullableNumber,
    balances_current: isNullableNumber,
    balances_limit: isNullableNumber,
    balances_iso_currency_code: isNullableString,
    custom_name: isNullableString,
    hide: isNullableBoolean,
    label_budget_id: isNullableString,
    graph_options_use_snapshots: isNullableBoolean,
    graph_options_use_transactions: isNullableBoolean,
    raw: isNullableObject,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType(
    "AccountModel",
    AccountModel.typeChecker,
  );

  constructor(data: unknown) {
    super();
    AccountModel.assertType(data);
    const r = data as Record<string, unknown>;
    Object.keys(AccountModel.typeChecker).forEach((k) => {
      (this as Record<string, unknown>)[k] = r[k];
    });
  }

  toJSON(): JSONAccount {
    return {
      account_id: this.account_id,
      item_id: this.item_id,
      institution_id: this.institution_id,
      name: this.name,
      type: this.type,
      subtype: this.subtype,
      mask: null,
      official_name: null,
      balances: {
        available: this.balances_available,
        current: this.balances_current,
        limit: this.balances_limit,
        iso_currency_code: this.balances_iso_currency_code,
        unofficial_currency_code: null,
      },
      custom_name: this.custom_name,
      hide: this.hide,
      label: { budget_id: this.label_budget_id },
      graphOptions: {
        useSnapshots: this.graph_options_use_snapshots,
        useTransactions: this.graph_options_use_transactions,
      },
    };
  }

  static toRow(
    a: Partial<JSONAccount> & { account_id: string },
    user_id: string,
  ): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
    if (!isUndefined(a.account_id)) r.account_id = a.account_id;
    if (!isUndefined(a.item_id)) r.item_id = a.item_id;
    if (!isUndefined(a.institution_id)) r.institution_id = a.institution_id;
    if (!isUndefined(a.name)) r.name = a.name;
    if (!isUndefined(a.type)) r.type = a.type;
    if (!isUndefined(a.subtype)) r.subtype = a.subtype;
    if (!isUndefined(a.custom_name)) r.custom_name = a.custom_name;
    if (!isUndefined(a.hide)) r.hide = a.hide;
    if (a.label && !isUndefined(a.label.budget_id)) r.label_budget_id = a.label.budget_id;
    if (a.balances) {
      if (!isUndefined(a.balances.available)) r.balances_available = a.balances.available;
      if (!isUndefined(a.balances.current)) r.balances_current = a.balances.current;
      if (!isUndefined(a.balances.limit)) r.balances_limit = a.balances.limit;
      if (!isUndefined(a.balances.iso_currency_code))
        r.balances_iso_currency_code = a.balances.iso_currency_code;
    }
    if (a.graphOptions) {
      if (!isUndefined(a.graphOptions.useSnapshots))
        r.graph_options_use_snapshots = a.graphOptions.useSnapshots;
      if (!isUndefined(a.graphOptions.useTransactions))
        r.graph_options_use_transactions = a.graphOptions.useTransactions;
    }
    const { custom_name, hide, label, graphOptions, ...providerData } = a;
    r.raw = providerData;
    return r;
  }
}

export const accountsTable = createTable({
  name: ACCOUNTS,
  primaryKey: ACCOUNT_ID,
  schema: {
    [ACCOUNT_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [ITEM_ID]: "VARCHAR(255) NOT NULL",
    [INSTITUTION_ID]: "VARCHAR(255) NOT NULL",
    [NAME]: "VARCHAR(255)",
    [TYPE]: "VARCHAR(50)",
    [SUBTYPE]: "VARCHAR(100)",
    [BALANCES_AVAILABLE]: "DECIMAL(15, 2)",
    [BALANCES_CURRENT]: "DECIMAL(15, 2)",
    [BALANCES_LIMIT]: "DECIMAL(15, 2)",
    [BALANCES_ISO_CURRENCY_CODE]: "VARCHAR(10)",
    [CUSTOM_NAME]: "TEXT",
    [HIDE]: "BOOLEAN DEFAULT FALSE",
    [LABEL_BUDGET_ID]: "UUID",
    [GRAPH_OPTIONS_USE_SNAPSHOTS]: "BOOLEAN DEFAULT TRUE",
    [GRAPH_OPTIONS_USE_TRANSACTIONS]: "BOOLEAN DEFAULT TRUE",
    [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: ITEM_ID }, { column: INSTITUTION_ID }],
  ModelClass: AccountModel,
});

export const accountColumns = Object.keys(accountsTable.schema);
