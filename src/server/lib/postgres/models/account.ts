import { AccountType, AccountSubtype } from "plaid";
import {
  JSONAccount, JSONHolding, JSONInstitution, JSONSecurity, isString, isUndefined,
  isNullableString, isNullableNumber, isNullableNumericLike, isNullableBoolean, isNullableDate, isNullableObject,
} from "common";
import {
  ACCOUNT_ID, USER_ID, ITEM_ID, INSTITUTION_ID, NAME, TYPE, SUBTYPE,
  BALANCES_AVAILABLE, BALANCES_CURRENT, BALANCES_LIMIT, BALANCES_ISO_CURRENCY_CODE,
  CUSTOM_NAME, HIDE, LABEL_BUDGET_ID, GRAPH_OPTIONS_USE_SNAPSHOTS,
  GRAPH_OPTIONS_USE_TRANSACTIONS, RAW, UPDATED, IS_DELETED, HOLDING_ID,
  SECURITY_ID, INSTITUTION_PRICE, INSTITUTION_PRICE_AS_OF, INSTITUTION_VALUE,
  COST_BASIS, QUANTITY, ISO_CURRENCY_CODE, TICKER_SYMBOL, CLOSE_PRICE,
  CLOSE_PRICE_AS_OF, ISIN, CUSIP, ACCOUNTS, HOLDINGS, INSTITUTIONS, SECURITIES, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";
import { toDate, toNullableNumber, toISODateString } from "../util";

export class AccountModel extends Model<JSONAccount> {
  account_id: string; user_id: string; item_id: string; institution_id: string;
  name: string; type: AccountType; subtype: AccountSubtype | null;
  balances_available: number; balances_current: number; balances_limit: number;
  balances_iso_currency_code: string; custom_name: string; hide: boolean;
  label_budget_id: string | null; graph_options_use_snapshots: boolean;
  graph_options_use_transactions: boolean; updated: Date; is_deleted: boolean;

  constructor(data: unknown) {
    super();
    AccountModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.account_id = r.account_id as string;
    this.user_id = r.user_id as string;
    this.item_id = r.item_id as string;
    this.institution_id = r.institution_id as string;
    this.name = (r.name as string) || "Unknown";
    this.type = (r.type as AccountType) || AccountType.Other;
    this.subtype = (r.subtype as AccountSubtype) || null;
    this.balances_available = toNullableNumber(r.balances_available) ?? 0;
    this.balances_current = toNullableNumber(r.balances_current) ?? 0;
    this.balances_limit = toNullableNumber(r.balances_limit) ?? 0;
    this.balances_iso_currency_code = (r.balances_iso_currency_code as string) || "USD";
    this.custom_name = (r.custom_name as string) || "";
    this.hide = (r.hide as boolean) ?? false;
    this.label_budget_id = (r.label_budget_id as string) ?? null;
    this.graph_options_use_snapshots = (r.graph_options_use_snapshots as boolean) ?? true;
    this.graph_options_use_transactions = (r.graph_options_use_transactions as boolean) ?? true;
    this.updated = r.updated ? toDate(r.updated) : new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONAccount {
    return {
      account_id: this.account_id, item_id: this.item_id, institution_id: this.institution_id,
      name: this.name, type: this.type, subtype: this.subtype, mask: null, official_name: null,
      balances: {
        available: this.balances_available, current: this.balances_current,
        limit: this.balances_limit, iso_currency_code: this.balances_iso_currency_code,
        unofficial_currency_code: null,
      },
      custom_name: this.custom_name, hide: this.hide, label: { budget_id: this.label_budget_id },
      graphOptions: { useSnapshots: this.graph_options_use_snapshots, useTransactions: this.graph_options_use_transactions },
    };
  }

  static fromJSON(a: Partial<JSONAccount> & { account_id: string }, user_id: string): Record<string, unknown> {
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
      if (!isUndefined(a.balances.iso_currency_code)) r.balances_iso_currency_code = a.balances.iso_currency_code;
    }
    if (a.graphOptions) {
      if (!isUndefined(a.graphOptions.useSnapshots)) r.graph_options_use_snapshots = a.graphOptions.useSnapshots;
      if (!isUndefined(a.graphOptions.useTransactions)) r.graph_options_use_transactions = a.graphOptions.useTransactions;
    }
    const { custom_name, hide, label, graphOptions, ...providerData } = a;
    r.raw = providerData;
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("AccountModel", {
    account_id: isString, user_id: isString, item_id: isString, institution_id: isString,
    name: isNullableString, type: isNullableString, subtype: isNullableString,
    balances_available: isNullableNumericLike, balances_current: isNullableNumericLike, balances_limit: isNullableNumericLike,
    balances_iso_currency_code: isNullableString, custom_name: isNullableString, hide: isNullableBoolean,
    label_budget_id: isNullableString, graph_options_use_snapshots: isNullableBoolean,
    graph_options_use_transactions: isNullableBoolean, raw: isNullableObject, updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export const accountsTable = createTable({
  name: ACCOUNTS,
  schema: {
    [ACCOUNT_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [ITEM_ID]: "VARCHAR(255) NOT NULL", [INSTITUTION_ID]: "VARCHAR(255) NOT NULL",
    [NAME]: "VARCHAR(255)", [TYPE]: "VARCHAR(50)", [SUBTYPE]: "VARCHAR(100)",
    [BALANCES_AVAILABLE]: "DECIMAL(15, 2)", [BALANCES_CURRENT]: "DECIMAL(15, 2)", [BALANCES_LIMIT]: "DECIMAL(15, 2)",
    [BALANCES_ISO_CURRENCY_CODE]: "VARCHAR(10)", [CUSTOM_NAME]: "TEXT", [HIDE]: "BOOLEAN DEFAULT FALSE",
    [LABEL_BUDGET_ID]: "UUID", [GRAPH_OPTIONS_USE_SNAPSHOTS]: "BOOLEAN DEFAULT TRUE",
    [GRAPH_OPTIONS_USE_TRANSACTIONS]: "BOOLEAN DEFAULT TRUE", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: ITEM_ID }, { column: INSTITUTION_ID }],
  ModelClass: AccountModel,
});
export const accountColumns = Object.keys(accountsTable.schema);

export class HoldingModel extends Model<JSONHolding> {
  holding_id: string; user_id: string; account_id: string; security_id: string;
  institution_price: number; institution_price_as_of: string | null; institution_value: number;
  cost_basis: number; quantity: number; iso_currency_code: string; updated: Date; is_deleted: boolean;

  constructor(data: unknown) {
    super();
    HoldingModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.holding_id = r.holding_id as string;
    this.user_id = r.user_id as string;
    this.account_id = r.account_id as string;
    this.security_id = r.security_id as string;
    this.institution_price = toNullableNumber(r.institution_price) ?? 0;
    this.institution_price_as_of = r.institution_price_as_of ? toISODateString(r.institution_price_as_of) : null;
    this.institution_value = toNullableNumber(r.institution_value) ?? 0;
    this.cost_basis = toNullableNumber(r.cost_basis) ?? 0;
    this.quantity = toNullableNumber(r.quantity) ?? 0;
    this.iso_currency_code = (r.iso_currency_code as string) || "USD";
    this.updated = r.updated ? toDate(r.updated) : new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONHolding {
    return {
      holding_id: this.holding_id, account_id: this.account_id, security_id: this.security_id,
      institution_price: this.institution_price, institution_price_as_of: this.institution_price_as_of,
      institution_value: this.institution_value, cost_basis: this.cost_basis, quantity: this.quantity,
      iso_currency_code: this.iso_currency_code, unofficial_currency_code: null,
    };
  }

  static fromJSON(h: Partial<JSONHolding> & { holding_id?: string }, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id, holding_id: h.holding_id || `${h.account_id}-${h.security_id}` };
    if (!isUndefined(h.account_id)) r.account_id = h.account_id;
    if (!isUndefined(h.security_id)) r.security_id = h.security_id;
    if (!isUndefined(h.institution_price)) r.institution_price = h.institution_price;
    if (!isUndefined(h.institution_price_as_of)) r.institution_price_as_of = h.institution_price_as_of;
    if (!isUndefined(h.institution_value)) r.institution_value = h.institution_value;
    if (!isUndefined(h.cost_basis)) r.cost_basis = h.cost_basis;
    if (!isUndefined(h.quantity)) r.quantity = h.quantity;
    if (!isUndefined(h.iso_currency_code)) r.iso_currency_code = h.iso_currency_code;
    r.raw = h;
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("HoldingModel", {
    holding_id: isString, user_id: isString, account_id: isString, security_id: isString,
    institution_price: isNullableNumericLike, institution_price_as_of: isNullableDate, institution_value: isNullableNumericLike,
    cost_basis: isNullableNumericLike, quantity: isNullableNumericLike, iso_currency_code: isNullableString,
    raw: isNullableObject, updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export const holdingsTable = createTable({
  name: HOLDINGS,
  schema: {
    [HOLDING_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [ACCOUNT_ID]: "VARCHAR(255) NOT NULL", [SECURITY_ID]: "VARCHAR(255) NOT NULL",
    [INSTITUTION_PRICE]: "DECIMAL(15, 6)", [INSTITUTION_PRICE_AS_OF]: "DATE",
    [INSTITUTION_VALUE]: "DECIMAL(15, 2)", [COST_BASIS]: "DECIMAL(15, 2)", [QUANTITY]: "DECIMAL(15, 6)",
    [ISO_CURRENCY_CODE]: "VARCHAR(10)", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: ACCOUNT_ID }, { column: SECURITY_ID }],
  ModelClass: HoldingModel,
});
export const holdingColumns = Object.keys(holdingsTable.schema);

export class InstitutionModel extends Model<JSONInstitution> {
  institution_id: string; name: string; updated: Date;

  constructor(data: unknown) {
    super();
    InstitutionModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.institution_id = r.institution_id as string;
    this.name = (r.name as string) || "Unknown";
    this.updated = r.updated ? toDate(r.updated) : new Date();
  }

  toJSON(): JSONInstitution {
    return {
      institution_id: this.institution_id, name: this.name, products: [], country_codes: [],
      url: null, primary_color: null, logo: null, routing_numbers: [], oauth: false, status: null,
    };
  }

  static fromJSON(i: Partial<JSONInstitution>): Record<string, unknown> {
    const r: Record<string, unknown> = {};
    if (i.institution_id !== undefined) r.institution_id = i.institution_id;
    if (i.name !== undefined) r.name = i.name;
    r.raw = i;
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("InstitutionModel", {
    institution_id: isString, name: isNullableString, raw: isNullableObject, updated: isNullableDate,
  });
}

export const institutionsTable = createTable({
  name: INSTITUTIONS,
  schema: {
    [INSTITUTION_ID]: "VARCHAR(255) PRIMARY KEY", [NAME]: "VARCHAR(255)", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  } as Schema<Record<string, unknown>>,
  ModelClass: InstitutionModel,
});
export const institutionColumns = Object.keys(institutionsTable.schema);

export class SecurityModel extends Model<JSONSecurity> {
  security_id: string; name: string | null; ticker_symbol: string | null; type: string | null;
  close_price: number | null; close_price_as_of: string | null; iso_currency_code: string | null;
  isin: string | null; cusip: string | null; updated: Date;

  constructor(data: unknown) {
    super();
    SecurityModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.security_id = r.security_id as string;
    this.name = (r.name as string) ?? null;
    this.ticker_symbol = (r.ticker_symbol as string) ?? null;
    this.type = (r.type as string) ?? null;
    this.close_price = toNullableNumber(r.close_price);
    this.close_price_as_of = r.close_price_as_of ? toISODateString(r.close_price_as_of) : null;
    this.iso_currency_code = (r.iso_currency_code as string) ?? null;
    this.isin = (r.isin as string) ?? null;
    this.cusip = (r.cusip as string) ?? null;
    this.updated = r.updated ? toDate(r.updated) : new Date();
  }

  toJSON(): JSONSecurity {
    return {
      security_id: this.security_id, name: this.name, ticker_symbol: this.ticker_symbol, type: this.type,
      close_price: this.close_price, close_price_as_of: this.close_price_as_of, iso_currency_code: this.iso_currency_code,
      isin: this.isin, cusip: this.cusip, sedol: null, institution_security_id: null, institution_id: null,
      proxy_security_id: null, is_cash_equivalent: null, unofficial_currency_code: null,
      market_identifier_code: null, sector: null, industry: null, option_contract: null, fixed_income: null,
    };
  }

  static fromJSON(s: Partial<JSONSecurity>): Record<string, unknown> {
    const r: Record<string, unknown> = {};
    if (s.security_id !== undefined) r.security_id = s.security_id;
    if (s.name !== undefined) r.name = s.name;
    if (s.ticker_symbol !== undefined) r.ticker_symbol = s.ticker_symbol;
    if (s.type !== undefined) r.type = s.type;
    if (s.close_price !== undefined) r.close_price = s.close_price;
    if (s.close_price_as_of !== undefined) r.close_price_as_of = s.close_price_as_of;
    if (s.iso_currency_code !== undefined) r.iso_currency_code = s.iso_currency_code;
    if (s.isin !== undefined) r.isin = s.isin;
    if (s.cusip !== undefined) r.cusip = s.cusip;
    r.raw = s;
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SecurityModel", {
    security_id: isString, name: isNullableString, ticker_symbol: isNullableString, type: isNullableString,
    close_price: isNullableNumericLike, close_price_as_of: isNullableDate, iso_currency_code: isNullableString,
    isin: isNullableString, cusip: isNullableString, raw: isNullableObject, updated: isNullableDate,
  });
}

export const securitiesTable = createTable({
  name: SECURITIES,
  schema: {
    [SECURITY_ID]: "VARCHAR(255) PRIMARY KEY", [NAME]: "VARCHAR(255)", [TICKER_SYMBOL]: "VARCHAR(50)",
    [TYPE]: "VARCHAR(50)", [CLOSE_PRICE]: "DECIMAL(15, 6)", [CLOSE_PRICE_AS_OF]: "DATE",
    [ISO_CURRENCY_CODE]: "VARCHAR(10)", [ISIN]: "VARCHAR(50)", [CUSIP]: "VARCHAR(50)",
    [RAW]: "JSONB", [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  } as Schema<Record<string, unknown>>,
  ModelClass: SecurityModel,
});
export const securityColumns = Object.keys(securitiesTable.schema);
