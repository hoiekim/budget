/**
 * Account, Holding, Institution, and Security models and schema definitions.
 */

import { AccountType, AccountSubtype } from "plaid";
import { JSONAccount, JSONHolding, JSONInstitution, JSONSecurity } from "common";
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
  HOLDING_ID,
  SECURITY_ID,
  INSTITUTION_PRICE,
  INSTITUTION_PRICE_AS_OF,
  INSTITUTION_VALUE,
  COST_BASIS,
  QUANTITY,
  ISO_CURRENCY_CODE,
  TICKER_SYMBOL,
  CLOSE_PRICE,
  CLOSE_PRICE_AS_OF,
  ISIN,
  CUSIP,
  ACCOUNTS,
  HOLDINGS,
  INSTITUTIONS,
  SECURITIES,
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
  isNullableNumber,
  isNullableBoolean,
  isNullableDate,
  toDate,
  toNullableNumber,
  isUndefined,
} from "./base";

// =============================================
// Account Interfaces
// =============================================

export interface AccountRow {
  account_id: string;
  user_id: string;
  item_id: string;
  institution_id: string;
  name: string | null | undefined;
  type: string | null | undefined;
  subtype: string | null | undefined;
  balances_available: string | number | null | undefined;
  balances_current: string | number | null | undefined;
  balances_limit: string | number | null | undefined;
  balances_iso_currency_code: string | null | undefined;
  custom_name: string | null | undefined;
  hide: boolean | null | undefined;
  label_budget_id: string | null | undefined;
  graph_options_use_snapshots: boolean | null | undefined;
  graph_options_use_transactions: boolean | null | undefined;
  raw: string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

// =============================================
// Account Model Class
// =============================================

export class AccountModel {
  account_id: string;
  user_id: string;
  item_id: string;
  institution_id: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  balances_available: number;
  balances_current: number;
  balances_limit: number;
  balances_iso_currency_code: string;
  custom_name: string;
  hide: boolean;
  label_budget_id: string | null;
  graph_options_use_snapshots: boolean;
  graph_options_use_transactions: boolean;
  updated: Date;
  is_deleted: boolean;

  constructor(row: AccountRow) {
    AccountModel.assertType(row);
    this.account_id = row.account_id;
    this.user_id = row.user_id;
    this.item_id = row.item_id;
    this.institution_id = row.institution_id;
    this.name = row.name || "Unknown";
    this.type = (row.type as AccountType) || AccountType.Other;
    this.subtype = (row.subtype as AccountSubtype) || null;
    this.balances_available = toNullableNumber(row.balances_available) ?? 0;
    this.balances_current = toNullableNumber(row.balances_current) ?? 0;
    this.balances_limit = toNullableNumber(row.balances_limit) ?? 0;
    this.balances_iso_currency_code = row.balances_iso_currency_code || "USD";
    this.custom_name = row.custom_name || "";
    this.hide = row.hide ?? false;
    this.label_budget_id = row.label_budget_id ?? null;
    this.graph_options_use_snapshots = row.graph_options_use_snapshots ?? true;
    this.graph_options_use_transactions = row.graph_options_use_transactions ?? true;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
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
      label: {
        budget_id: this.label_budget_id,
      },
      graphOptions: {
        useSnapshots: this.graph_options_use_snapshots,
        useTransactions: this.graph_options_use_transactions,
      },
    };
  }

  static fromJSON(
    account: Partial<JSONAccount> & { account_id: string },
    user_id: string
  ): Partial<AccountRow> {
    const row: Partial<AccountRow> = { user_id };

    if (!isUndefined(account.account_id)) row.account_id = account.account_id;
    if (!isUndefined(account.item_id)) row.item_id = account.item_id;
    if (!isUndefined(account.institution_id)) row.institution_id = account.institution_id;
    if (!isUndefined(account.name)) row.name = account.name;
    if (!isUndefined(account.type)) row.type = account.type;
    if (!isUndefined(account.subtype)) row.subtype = account.subtype;
    if (!isUndefined(account.custom_name)) row.custom_name = account.custom_name;
    if (!isUndefined(account.hide)) row.hide = account.hide;

    if (account.label) {
      if (!isUndefined(account.label.budget_id)) row.label_budget_id = account.label.budget_id;
    }
    if (account.balances) {
      if (!isUndefined(account.balances.available))
        row.balances_available = account.balances.available;
      if (!isUndefined(account.balances.current)) row.balances_current = account.balances.current;
      if (!isUndefined(account.balances.limit)) row.balances_limit = account.balances.limit;
      if (!isUndefined(account.balances.iso_currency_code))
        row.balances_iso_currency_code = account.balances.iso_currency_code;
    }
    if (account.graphOptions) {
      if (!isUndefined(account.graphOptions.useSnapshots))
        row.graph_options_use_snapshots = account.graphOptions.useSnapshots;
      if (!isUndefined(account.graphOptions.useTransactions))
        row.graph_options_use_transactions = account.graphOptions.useTransactions;
    }

    // Store provider data in raw (excluding user-edited fields)
    const { custom_name, hide, label, graphOptions, ...providerData } = account;
    row.raw = JSON.stringify(providerData);

    return row;
  }

  static assertType: AssertTypeFn<AccountRow> = createAssertType<AccountRow>("AccountModel", {
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
    raw: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  } as PropertyChecker<AccountRow>);
}

// =============================================
// Account Schema
// =============================================

export const accountSchema: Schema<AccountRow> = {
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
};

export const accountConstraints: Constraints = [];

export const accountColumns = Object.keys(accountSchema);

export const accountIndexes = [
  { table: ACCOUNTS, column: USER_ID },
  { table: ACCOUNTS, column: ITEM_ID },
  { table: ACCOUNTS, column: INSTITUTION_ID },
];

// =============================================
// Holding Interfaces & Model
// =============================================

export interface HoldingRow {
  holding_id: string;
  user_id: string;
  account_id: string;
  security_id: string;
  institution_price: string | number | null | undefined;
  institution_price_as_of: string | null | undefined;
  institution_value: string | number | null | undefined;
  cost_basis: string | number | null | undefined;
  quantity: string | number | null | undefined;
  iso_currency_code: string | null | undefined;
  raw: string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

export class HoldingModel {
  holding_id: string;
  user_id: string;
  account_id: string;
  security_id: string;
  institution_price: number;
  institution_price_as_of: string | null;
  institution_value: number;
  cost_basis: number;
  quantity: number;
  iso_currency_code: string;
  updated: Date;
  is_deleted: boolean;

  constructor(row: HoldingRow) {
    HoldingModel.assertType(row);
    this.holding_id = row.holding_id;
    this.user_id = row.user_id;
    this.account_id = row.account_id;
    this.security_id = row.security_id;
    this.institution_price = toNullableNumber(row.institution_price) ?? 0;
    this.institution_price_as_of = row.institution_price_as_of ?? null;
    this.institution_value = toNullableNumber(row.institution_value) ?? 0;
    this.cost_basis = toNullableNumber(row.cost_basis) ?? 0;
    this.quantity = toNullableNumber(row.quantity) ?? 0;
    this.iso_currency_code = row.iso_currency_code || "USD";
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  toJSON(): JSONHolding {
    return {
      holding_id: this.holding_id,
      account_id: this.account_id,
      security_id: this.security_id,
      institution_price: this.institution_price,
      institution_price_as_of: this.institution_price_as_of,
      institution_value: this.institution_value,
      cost_basis: this.cost_basis,
      quantity: this.quantity,
      iso_currency_code: this.iso_currency_code,
      unofficial_currency_code: null,
    };
  }

  static fromJSON(
    holding: Partial<JSONHolding> & { holding_id?: string },
    user_id: string
  ): Partial<HoldingRow> {
    const row: Partial<HoldingRow> = { user_id };

    // Generate holding_id if not provided
    row.holding_id = holding.holding_id || `${holding.account_id}-${holding.security_id}`;

    if (!isUndefined(holding.account_id)) row.account_id = holding.account_id;
    if (!isUndefined(holding.security_id)) row.security_id = holding.security_id;
    if (!isUndefined(holding.institution_price)) row.institution_price = holding.institution_price;
    if (!isUndefined(holding.institution_price_as_of))
      row.institution_price_as_of = holding.institution_price_as_of;
    if (!isUndefined(holding.institution_value)) row.institution_value = holding.institution_value;
    if (!isUndefined(holding.cost_basis)) row.cost_basis = holding.cost_basis;
    if (!isUndefined(holding.quantity)) row.quantity = holding.quantity;
    if (!isUndefined(holding.iso_currency_code)) row.iso_currency_code = holding.iso_currency_code;

    row.raw = JSON.stringify(holding);

    return row;
  }

  static assertType: AssertTypeFn<HoldingRow> = createAssertType<HoldingRow>("HoldingModel", {
    holding_id: isString,
    user_id: isString,
    account_id: isString,
    security_id: isString,
    institution_price: isNullableNumber,
    institution_price_as_of: isNullableString,
    institution_value: isNullableNumber,
    cost_basis: isNullableNumber,
    quantity: isNullableNumber,
    iso_currency_code: isNullableString,
    raw: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  } as PropertyChecker<HoldingRow>);
}

// =============================================
// Holding Schema
// =============================================

export const holdingSchema: Schema<HoldingRow> = {
  [HOLDING_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
  [SECURITY_ID]: "VARCHAR(255) NOT NULL",
  [INSTITUTION_PRICE]: "DECIMAL(15, 6)",
  [INSTITUTION_PRICE_AS_OF]: "DATE",
  [INSTITUTION_VALUE]: "DECIMAL(15, 2)",
  [COST_BASIS]: "DECIMAL(15, 2)",
  [QUANTITY]: "DECIMAL(15, 6)",
  [ISO_CURRENCY_CODE]: "VARCHAR(10)",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const holdingConstraints: Constraints = [];

export const holdingColumns = Object.keys(holdingSchema);

export const holdingIndexes = [
  { table: HOLDINGS, column: USER_ID },
  { table: HOLDINGS, column: ACCOUNT_ID },
  { table: HOLDINGS, column: SECURITY_ID },
];

// =============================================
// Institution Interfaces & Model
// =============================================

export interface InstitutionRow {
  institution_id: string;
  name: string | null | undefined;
  raw: string | null | undefined;
  updated: Date | null | undefined;
}

export class InstitutionModel {
  institution_id: string;
  name: string;
  updated: Date;

  constructor(row: InstitutionRow) {
    InstitutionModel.assertType(row);
    this.institution_id = row.institution_id;
    this.name = row.name || "Unknown";
    this.updated = row.updated ? toDate(row.updated) : new Date();
  }

  toJSON(): JSONInstitution {
    return {
      institution_id: this.institution_id,
      name: this.name,
      products: [],
      country_codes: [],
      url: null,
      primary_color: null,
      logo: null,
      routing_numbers: [],
      oauth: false,
      status: null,
    };
  }

  static fromJSON(institution: Partial<JSONInstitution>): Partial<InstitutionRow> {
    const row: Partial<InstitutionRow> = {};

    if (institution.institution_id !== undefined) row.institution_id = institution.institution_id;
    if (institution.name !== undefined) row.name = institution.name;

    row.raw = JSON.stringify(institution);

    return row;
  }

  static assertType: AssertTypeFn<InstitutionRow> = createAssertType<InstitutionRow>("InstitutionModel", {
    institution_id: isString,
    name: isNullableString,
    raw: isNullableString,
    updated: isNullableDate,
  } as PropertyChecker<InstitutionRow>);
}

// =============================================
// Institution Schema
// =============================================

export const institutionSchema: Schema<InstitutionRow> = {
  [INSTITUTION_ID]: "VARCHAR(255) PRIMARY KEY",
  [NAME]: "VARCHAR(255)",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

export const institutionColumns = Object.keys(institutionSchema);

// =============================================
// Security Interfaces & Model
// =============================================

export interface SecurityRow {
  security_id: string;
  name: string | null | undefined;
  ticker_symbol: string | null | undefined;
  type: string | null | undefined;
  close_price: string | number | null | undefined;
  close_price_as_of: string | null | undefined;
  iso_currency_code: string | null | undefined;
  isin: string | null | undefined;
  cusip: string | null | undefined;
  raw: string | null | undefined;
  updated: Date | null | undefined;
}

export class SecurityModel {
  security_id: string;
  name: string | null;
  ticker_symbol: string | null;
  type: string | null;
  close_price: number | null;
  close_price_as_of: string | null;
  iso_currency_code: string | null;
  isin: string | null;
  cusip: string | null;
  updated: Date;

  constructor(row: SecurityRow) {
    SecurityModel.assertType(row);
    this.security_id = row.security_id;
    this.name = row.name ?? null;
    this.ticker_symbol = row.ticker_symbol ?? null;
    this.type = row.type ?? null;
    this.close_price = toNullableNumber(row.close_price);
    this.close_price_as_of = row.close_price_as_of ?? null;
    this.iso_currency_code = row.iso_currency_code ?? null;
    this.isin = row.isin ?? null;
    this.cusip = row.cusip ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
  }

  toJSON(): JSONSecurity {
    return {
      security_id: this.security_id,
      name: this.name,
      ticker_symbol: this.ticker_symbol,
      type: this.type,
      close_price: this.close_price,
      close_price_as_of: this.close_price_as_of,
      iso_currency_code: this.iso_currency_code,
      isin: this.isin,
      cusip: this.cusip,
      sedol: null,
      institution_security_id: null,
      institution_id: null,
      proxy_security_id: null,
      is_cash_equivalent: null,
      unofficial_currency_code: null,
      market_identifier_code: null,
      sector: null,
      industry: null,
      option_contract: null,
      fixed_income: null,
    };
  }

  static fromJSON(security: Partial<JSONSecurity>): Partial<SecurityRow> {
    const row: Partial<SecurityRow> = {};

    if (security.security_id !== undefined) row.security_id = security.security_id;
    if (security.name !== undefined) row.name = security.name;
    if (security.ticker_symbol !== undefined) row.ticker_symbol = security.ticker_symbol;
    if (security.type !== undefined) row.type = security.type;
    if (security.close_price !== undefined) row.close_price = security.close_price;
    if (security.close_price_as_of !== undefined) row.close_price_as_of = security.close_price_as_of;
    if (security.iso_currency_code !== undefined) row.iso_currency_code = security.iso_currency_code;
    if (security.isin !== undefined) row.isin = security.isin;
    if (security.cusip !== undefined) row.cusip = security.cusip;

    row.raw = JSON.stringify(security);

    return row;
  }

  static assertType: AssertTypeFn<SecurityRow> = createAssertType<SecurityRow>("SecurityModel", {
    security_id: isString,
    name: isNullableString,
    ticker_symbol: isNullableString,
    type: isNullableString,
    close_price: isNullableNumber,
    close_price_as_of: isNullableString,
    iso_currency_code: isNullableString,
    isin: isNullableString,
    cusip: isNullableString,
    raw: isNullableString,
    updated: isNullableDate,
  } as PropertyChecker<SecurityRow>);
}

// =============================================
// Security Schema
// =============================================

export const securitySchema: Schema<SecurityRow> = {
  [SECURITY_ID]: "VARCHAR(255) PRIMARY KEY",
  [NAME]: "VARCHAR(255)",
  [TICKER_SYMBOL]: "VARCHAR(50)",
  [TYPE]: "VARCHAR(50)",
  [CLOSE_PRICE]: "DECIMAL(15, 6)",
  [CLOSE_PRICE_AS_OF]: "DATE",
  [ISO_CURRENCY_CODE]: "VARCHAR(10)",
  [ISIN]: "VARCHAR(50)",
  [CUSIP]: "VARCHAR(50)",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

export const securityColumns = Object.keys(securitySchema);
