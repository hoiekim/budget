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
  GRAPH_OPTIONS_USE_HOLDING_SNAPSHOTS,
  GRAPH_OPTIONS_USE_TRANSACTIONS,
  RAW,
  UPDATED,
  IS_DELETED,
  ACCOUNTS,
  USERS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const accountSchema = {
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
  [GRAPH_OPTIONS_USE_HOLDING_SNAPSHOTS]: "BOOLEAN DEFAULT TRUE",
  [GRAPH_OPTIONS_USE_TRANSACTIONS]: "BOOLEAN DEFAULT TRUE",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type AccountSchema = typeof accountSchema;
type AccountRow = { [k in keyof AccountSchema]: RowValueType };

export class AccountModel extends Model<JSONAccount, AccountSchema> implements AccountRow {
  declare account_id: string;
  declare user_id: string;
  declare item_id: string;
  declare institution_id: string;
  declare name: string;
  declare type: AccountType;
  declare subtype: AccountSubtype | null;
  declare balances_available: number;
  declare balances_current: number;
  declare balances_limit: number;
  declare balances_iso_currency_code: string;
  declare custom_name: string;
  declare hide: boolean;
  declare label_budget_id: string | null;
  declare graph_options_use_snapshots: boolean;
  declare graph_options_use_holding_snapshots: boolean;
  declare graph_options_use_transactions: boolean;
  declare raw: object | null;
  declare updated: string | null;
  declare is_deleted: boolean;

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
    graph_options_use_holding_snapshots: isNullableBoolean,
    graph_options_use_transactions: isNullableBoolean,
    raw: isNullableObject,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, AccountModel.typeChecker);
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
        useHoldingSnapshots: this.graph_options_use_holding_snapshots ?? true,
        useTransactions: this.graph_options_use_transactions,
      },
    };
  }

  static fromJSON(
    a: Partial<JSONAccount> & { account_id: string },
    user_id: string,
  ): Partial<AccountRow> {
    const r: Partial<AccountRow> = { user_id };
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
      if (!isUndefined(a.graphOptions.useHoldingSnapshots))
        r.graph_options_use_holding_snapshots = a.graphOptions.useHoldingSnapshots;
      if (!isUndefined(a.graphOptions.useTransactions))
        r.graph_options_use_transactions = a.graphOptions.useTransactions;
    }
    const { custom_name: _custom_name, hide: _hide, label: _label, graphOptions: _graphOptions, ...providerData } = a;
    r.raw = providerData;
    return r;
  }
}

export const accountsTable = createTable({
  name: ACCOUNTS,
  primaryKey: ACCOUNT_ID,
  schema: accountSchema,
  indexes: [{ column: USER_ID }, { column: ITEM_ID }, { column: INSTITUTION_ID }],
  ModelClass: AccountModel,
});

export const accountColumns = Object.keys(accountsTable.schema);
