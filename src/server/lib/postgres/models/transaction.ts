/**
 * Transaction, Investment Transaction, and Split Transaction models and schema definitions.
 */

import {
  TransactionPaymentChannelEnum,
  InvestmentTransactionType,
  InvestmentTransactionSubtype,
} from "plaid";
import {
  JSONTransaction,
  JSONInvestmentTransaction,
  JSONSplitTransaction,
  LocalDate,
  isString,
  isUndefined,
} from "common";
import {
  TRANSACTION_ID,
  USER_ID,
  ACCOUNT_ID,
  NAME,
  MERCHANT_NAME,
  AMOUNT,
  ISO_CURRENCY_CODE,
  DATE,
  PENDING,
  PENDING_TRANSACTION_ID,
  PAYMENT_CHANNEL,
  LOCATION_COUNTRY,
  LOCATION_REGION,
  LOCATION_CITY,
  LABEL_BUDGET_ID,
  LABEL_CATEGORY_ID,
  LABEL_MEMO,
  RAW,
  UPDATED,
  IS_DELETED,
  INVESTMENT_TRANSACTION_ID,
  SECURITY_ID,
  QUANTITY,
  PRICE,
  TYPE,
  SUBTYPE,
  SPLIT_TRANSACTION_ID,
  CUSTOM_NAME,
  TRANSACTIONS,
  INVESTMENT_TRANSACTIONS,
  SPLIT_TRANSACTIONS,
  USERS,
} from "./common";
import {
  Schema,
  Constraints,
  Table,
  PropertyChecker,
  AssertTypeFn,
  createAssertType,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
  isNullableDate,
  toDate,
  toNullableNumber,
  toISODateString,
} from "./base";

// =============================================
// Transaction Interfaces
// =============================================

export interface TransactionRow {
  transaction_id: string;
  user_id: string;
  account_id: string;
  name: string | null | undefined;
  merchant_name: string | null | undefined;
  amount: string | number | null | undefined;
  iso_currency_code: string | null | undefined;
  date: Date;
  pending: boolean | null | undefined;
  pending_transaction_id: string | null | undefined;
  payment_channel: string | null | undefined;
  location_country: string | null | undefined;
  location_region: string | null | undefined;
  location_city: string | null | undefined;
  label_budget_id: string | null | undefined;
  label_category_id: string | null | undefined;
  label_memo: string | null | undefined;
  raw: string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

// =============================================
// Transaction Model Class
// =============================================

export class TransactionModel {
  transaction_id: string;
  user_id: string;
  account_id: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  pending: boolean;
  pending_transaction_id: string | null;
  payment_channel: TransactionPaymentChannelEnum;
  location_country: string | null;
  location_region: string | null;
  location_city: string | null;
  label_budget_id: string | null;
  label_category_id: string | null;
  label_memo: string | null;
  updated: Date;
  is_deleted: boolean;

  constructor(row: TransactionRow) {
    TransactionModel.assertType(row);
    this.transaction_id = row.transaction_id;
    this.user_id = row.user_id;
    this.account_id = row.account_id;
    this.name = row.name || "Unknown";
    this.merchant_name = row.merchant_name ?? null;
    this.amount = toNullableNumber(row.amount) ?? 0;
    this.iso_currency_code = row.iso_currency_code ?? null;
    this.date = toISODateString(row.date);
    this.pending = row.pending ?? false;
    this.pending_transaction_id = row.pending_transaction_id ?? null;
    this.payment_channel =
      (row.payment_channel as TransactionPaymentChannelEnum) ||
      TransactionPaymentChannelEnum.InStore;
    this.location_country = row.location_country ?? null;
    this.location_region = row.location_region ?? null;
    this.location_city = row.location_city ?? null;
    this.label_budget_id = row.label_budget_id ?? null;
    this.label_category_id = row.label_category_id ?? null;
    this.label_memo = row.label_memo ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  toJSON(): JSONTransaction {
    return {
      transaction_id: this.transaction_id,
      account_id: this.account_id,
      name: this.name,
      merchant_name: this.merchant_name,
      amount: this.amount,
      iso_currency_code: this.iso_currency_code,
      date: this.date,
      pending: this.pending,
      pending_transaction_id: this.pending_transaction_id,
      payment_channel: this.payment_channel,
      label: {
        budget_id: this.label_budget_id,
        category_id: this.label_category_id,
        memo: this.label_memo,
      },
      location: {
        address: null,
        city: this.location_city,
        region: this.location_region,
        postal_code: null,
        country: this.location_country,
        store_number: null,
        lat: null,
        lon: null,
      },
      payment_meta: {
        reference_number: null,
        ppd_id: null,
        payee: null,
        by_order_of: null,
        payer: null,
        payment_method: null,
        payment_processor: null,
        reason: null,
      },
      category_id: null,
      category: null,
      account_owner: null,
      unofficial_currency_code: null,
      authorized_date: null,
      authorized_datetime: null,
      datetime: null,
      transaction_code: null,
    };
  }

  static fromJSON(
    tx: Partial<JSONTransaction> & { transaction_id: string },
    user_id: string
  ): Partial<TransactionRow> {
    const row: Partial<TransactionRow> = { user_id };

    if (!isUndefined(tx.transaction_id)) row.transaction_id = tx.transaction_id;
    if (!isUndefined(tx.account_id)) row.account_id = tx.account_id;
    if (!isUndefined(tx.name)) row.name = tx.name;
    if (!isUndefined(tx.merchant_name)) row.merchant_name = tx.merchant_name;
    if (!isUndefined(tx.amount)) row.amount = tx.amount;
    if (!isUndefined(tx.iso_currency_code)) row.iso_currency_code = tx.iso_currency_code;
    if (!isUndefined(tx.authorized_date || tx.date))
      row.date = new LocalDate((tx.authorized_date || tx.date)!);
    if (!isUndefined(tx.pending)) row.pending = tx.pending;
    if (!isUndefined(tx.pending_transaction_id))
      row.pending_transaction_id = tx.pending_transaction_id;
    if (!isUndefined(tx.payment_channel)) row.payment_channel = tx.payment_channel;

    if (!isUndefined(tx.location)) {
      if (!isUndefined(tx.location.country)) row.location_country = tx.location.country;
      if (!isUndefined(tx.location.region)) row.location_region = tx.location.region;
      if (!isUndefined(tx.location.city)) row.location_city = tx.location.city;
    }

    if (!isUndefined(tx.label)) {
      if (!isUndefined(tx.label.budget_id)) row.label_budget_id = tx.label.budget_id;
      if (!isUndefined(tx.label.category_id)) row.label_category_id = tx.label.category_id;
      if (!isUndefined(tx.label.memo)) row.label_memo = tx.label.memo;
    }

    // Store full provider object in raw (excluding label which is user-edited)
    const { label, ...providerData } = tx;
    row.raw = JSON.stringify(providerData);

    return row;
  }

  static assertType: AssertTypeFn<TransactionRow> = createAssertType<TransactionRow>("TransactionModel", {
    transaction_id: isString,
    user_id: isString,
    account_id: isString,
    name: isNullableString,
    merchant_name: isNullableString,
    amount: isNullableNumber,
    iso_currency_code: isNullableString,
    date: isNullableDate,
    pending: isNullableBoolean,
    pending_transaction_id: isNullableString,
    payment_channel: isNullableString,
    location_country: isNullableString,
    location_region: isNullableString,
    location_city: isNullableString,
    label_budget_id: isNullableString,
    label_category_id: isNullableString,
    label_memo: isNullableString,
    raw: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  } as PropertyChecker<TransactionRow>);
}

// =============================================
// Transaction Schema
// =============================================

export const transactionSchema: Schema<TransactionRow> = {
  [TRANSACTION_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
  [NAME]: "TEXT",
  [MERCHANT_NAME]: "TEXT",
  [AMOUNT]: "DECIMAL(15, 2)",
  [ISO_CURRENCY_CODE]: "VARCHAR(10)",
  [DATE]: "DATE NOT NULL",
  [PENDING]: "BOOLEAN DEFAULT FALSE",
  [PENDING_TRANSACTION_ID]: "VARCHAR(255)",
  [PAYMENT_CHANNEL]: "TEXT",
  [LOCATION_COUNTRY]: "TEXT",
  [LOCATION_REGION]: "TEXT",
  [LOCATION_CITY]: "TEXT",
  [LABEL_BUDGET_ID]: "UUID",
  [LABEL_CATEGORY_ID]: "UUID",
  [LABEL_MEMO]: "TEXT",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const transactionConstraints: Constraints = [];

export const transactionColumns = Object.keys(transactionSchema);

export const transactionIndexes = [
  { table: TRANSACTIONS, column: USER_ID },
  { table: TRANSACTIONS, column: ACCOUNT_ID },
  { table: TRANSACTIONS, column: DATE },
  { table: TRANSACTIONS, column: PENDING },
];

// =============================================
// Investment Transaction Interfaces
// =============================================

export interface InvestmentTransactionRow {
  investment_transaction_id: string;
  user_id: string;
  account_id: string;
  security_id: string | null | undefined;
  date: Date;
  name: string | null | undefined;
  amount: string | number | null | undefined;
  quantity: string | number | null | undefined;
  price: string | number | null | undefined;
  iso_currency_code: string | null | undefined;
  type: string | null | undefined;
  subtype: string | null | undefined;
  label_budget_id: string | null | undefined;
  label_category_id: string | null | undefined;
  label_memo: string | null | undefined;
  raw: string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

// =============================================
// Investment Transaction Model Class
// =============================================

export class InvestmentTransactionModel {
  investment_transaction_id: string;
  user_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  name: string;
  amount: number;
  quantity: number;
  price: number;
  iso_currency_code: string | null;
  type: InvestmentTransactionType;
  subtype: InvestmentTransactionSubtype;
  label_budget_id: string | null;
  label_category_id: string | null;
  label_memo: string | null;
  updated: Date;
  is_deleted: boolean;

  constructor(row: InvestmentTransactionRow) {
    InvestmentTransactionModel.assertType(row);
    this.investment_transaction_id = row.investment_transaction_id;
    this.user_id = row.user_id;
    this.account_id = row.account_id;
    this.security_id = row.security_id ?? null;
    this.date = toISODateString(row.date);
    this.name = row.name || "Unknown";
    this.amount = toNullableNumber(row.amount) ?? 0;
    this.quantity = toNullableNumber(row.quantity) ?? 0;
    this.price = toNullableNumber(row.price) ?? 0;
    this.iso_currency_code = row.iso_currency_code ?? null;
    this.type = (row.type as InvestmentTransactionType) || InvestmentTransactionType.Transfer;
    this.subtype =
      (row.subtype as InvestmentTransactionSubtype) || InvestmentTransactionSubtype.Transfer;
    this.label_budget_id = row.label_budget_id ?? null;
    this.label_category_id = row.label_category_id ?? null;
    this.label_memo = row.label_memo ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  toJSON(): JSONInvestmentTransaction {
    return {
      investment_transaction_id: this.investment_transaction_id,
      account_id: this.account_id,
      security_id: this.security_id,
      date: this.date,
      name: this.name,
      quantity: this.quantity,
      amount: this.amount,
      price: this.price,
      iso_currency_code: this.iso_currency_code,
      type: this.type,
      subtype: this.subtype,
      fees: null,
      unofficial_currency_code: null,
      label: {
        budget_id: this.label_budget_id,
        category_id: this.label_category_id,
        memo: this.label_memo,
      },
    };
  }

  static fromJSON(
    tx: Partial<JSONInvestmentTransaction> & { investment_transaction_id: string },
    user_id: string
  ): Partial<InvestmentTransactionRow> {
    const row: Partial<InvestmentTransactionRow> = { user_id };

    if (tx.investment_transaction_id !== undefined)
      row.investment_transaction_id = tx.investment_transaction_id;
    if (tx.account_id !== undefined) row.account_id = tx.account_id;
    if (tx.security_id !== undefined) row.security_id = tx.security_id;
    if (tx.date !== undefined) row.date = new LocalDate(tx.date);
    if (tx.name !== undefined) row.name = tx.name;
    if (tx.amount !== undefined) row.amount = tx.amount;
    if (tx.quantity !== undefined) row.quantity = tx.quantity;
    if (tx.price !== undefined) row.price = tx.price;
    if (tx.iso_currency_code !== undefined) row.iso_currency_code = tx.iso_currency_code;
    if (tx.type !== undefined) row.type = tx.type;
    if (tx.subtype !== undefined) row.subtype = tx.subtype;

    if (tx.label) {
      if (tx.label.budget_id !== undefined) row.label_budget_id = tx.label.budget_id;
      if (tx.label.category_id !== undefined) row.label_category_id = tx.label.category_id;
      if (tx.label.memo !== undefined) row.label_memo = tx.label.memo;
    }

    const { label, ...providerData } = tx;
    row.raw = JSON.stringify(providerData);

    return row;
  }

  static assertType: AssertTypeFn<InvestmentTransactionRow> = createAssertType<InvestmentTransactionRow>("InvestmentTransactionModel", {
    investment_transaction_id: isString,
    user_id: isString,
    account_id: isString,
    security_id: isNullableString,
    date: isNullableDate,
    name: isNullableString,
    amount: isNullableNumber,
    quantity: isNullableNumber,
    price: isNullableNumber,
    iso_currency_code: isNullableString,
    type: isNullableString,
    subtype: isNullableString,
    label_budget_id: isNullableString,
    label_category_id: isNullableString,
    label_memo: isNullableString,
    raw: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  } as PropertyChecker<InvestmentTransactionRow>);
}

// =============================================
// Investment Transaction Schema
// =============================================

export const investmentTransactionSchema: Schema<InvestmentTransactionRow> = {
  [INVESTMENT_TRANSACTION_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
  [SECURITY_ID]: "VARCHAR(255)",
  [DATE]: "DATE NOT NULL",
  [NAME]: "TEXT",
  [AMOUNT]: "DECIMAL(15, 2)",
  [QUANTITY]: "DECIMAL(15, 6)",
  [PRICE]: "DECIMAL(15, 6)",
  [ISO_CURRENCY_CODE]: "VARCHAR(10)",
  [TYPE]: "TEXT",
  [SUBTYPE]: "TEXT",
  [LABEL_BUDGET_ID]: "UUID",
  [LABEL_CATEGORY_ID]: "UUID",
  [LABEL_MEMO]: "TEXT",
  [RAW]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const investmentTransactionConstraints: Constraints = [];

export const investmentTransactionColumns = Object.keys(investmentTransactionSchema);

export const investmentTransactionIndexes = [
  { table: INVESTMENT_TRANSACTIONS, column: USER_ID },
  { table: INVESTMENT_TRANSACTIONS, column: ACCOUNT_ID },
  { table: INVESTMENT_TRANSACTIONS, column: DATE },
];

// =============================================
// Split Transaction Interfaces
// =============================================

export interface SplitTransactionRow {
  split_transaction_id: string;
  user_id: string;
  transaction_id: string;
  account_id: string;
  amount: string | number | null | undefined;
  date: Date;
  custom_name: string | null | undefined;
  label_budget_id: string | null | undefined;
  label_category_id: string | null | undefined;
  label_memo: string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

// =============================================
// Split Transaction Model Class
// =============================================

export class SplitTransactionModel {
  split_transaction_id: string;
  user_id: string;
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  custom_name: string;
  label_budget_id: string | null;
  label_category_id: string | null;
  label_memo: string | null;
  updated: Date;
  is_deleted: boolean;

  constructor(row: SplitTransactionRow) {
    SplitTransactionModel.assertType(row);
    this.split_transaction_id = row.split_transaction_id;
    this.user_id = row.user_id;
    this.transaction_id = row.transaction_id;
    this.account_id = row.account_id;
    this.amount = toNullableNumber(row.amount) ?? 0;
    this.date = toISODateString(row.date);
    this.custom_name = row.custom_name || "";
    this.label_budget_id = row.label_budget_id ?? null;
    this.label_category_id = row.label_category_id ?? null;
    this.label_memo = row.label_memo ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  toJSON(): JSONSplitTransaction {
    return {
      split_transaction_id: this.split_transaction_id,
      transaction_id: this.transaction_id,
      account_id: this.account_id,
      amount: this.amount,
      date: this.date,
      custom_name: this.custom_name,
      label: {
        budget_id: this.label_budget_id,
        category_id: this.label_category_id,
        memo: this.label_memo,
      },
    };
  }

  static fromJSON(
    tx: Partial<JSONSplitTransaction>,
    user_id: string
  ): Partial<SplitTransactionRow> {
    const row: Partial<SplitTransactionRow> = { user_id };

    if (tx.split_transaction_id !== undefined) row.split_transaction_id = tx.split_transaction_id;
    if (tx.transaction_id !== undefined) row.transaction_id = tx.transaction_id;
    if (tx.account_id !== undefined) row.account_id = tx.account_id;
    if (tx.amount !== undefined) row.amount = tx.amount;
    if (tx.date !== undefined) row.date = new LocalDate(tx.date);
    if (tx.custom_name !== undefined) row.custom_name = tx.custom_name;

    if (tx.label) {
      if (tx.label.budget_id !== undefined) row.label_budget_id = tx.label.budget_id;
      if (tx.label.category_id !== undefined) row.label_category_id = tx.label.category_id;
      if (tx.label.memo !== undefined) row.label_memo = tx.label.memo;
    }

    return row;
  }

  static assertType: AssertTypeFn<SplitTransactionRow> = createAssertType<SplitTransactionRow>("SplitTransactionModel", {
    split_transaction_id: isString,
    user_id: isString,
    transaction_id: isString,
    account_id: isString,
    amount: isNullableNumber,
    date: isNullableDate,
    custom_name: isNullableString,
    label_budget_id: isNullableString,
    label_category_id: isNullableString,
    label_memo: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  } as PropertyChecker<SplitTransactionRow>);
}

// =============================================
// Split Transaction Schema
// =============================================

export const splitTransactionSchema: Schema<SplitTransactionRow> = {
  [SPLIT_TRANSACTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [TRANSACTION_ID]: "VARCHAR(255) NOT NULL",
  [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
  [AMOUNT]: "DECIMAL(15, 2) DEFAULT 0",
  [DATE]: "DATE NOT NULL",
  [CUSTOM_NAME]: "TEXT DEFAULT ''",
  [LABEL_BUDGET_ID]: "UUID",
  [LABEL_CATEGORY_ID]: "UUID",
  [LABEL_MEMO]: "TEXT",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const splitTransactionConstraints: Constraints = [];

export const splitTransactionColumns = Object.keys(splitTransactionSchema);

export const splitTransactionIndexes = [
  { table: SPLIT_TRANSACTIONS, column: USER_ID },
  { table: SPLIT_TRANSACTIONS, column: TRANSACTION_ID },
  { table: SPLIT_TRANSACTIONS, column: ACCOUNT_ID },
];

export const transactionTable: Table = {
  name: TRANSACTIONS,
  schema: transactionSchema as Schema<Record<string, unknown>>,
  constraints: transactionConstraints,
  indexes: transactionIndexes,
};

export const investmentTransactionTable: Table = {
  name: INVESTMENT_TRANSACTIONS,
  schema: investmentTransactionSchema as Schema<Record<string, unknown>>,
  constraints: investmentTransactionConstraints,
  indexes: investmentTransactionIndexes,
};

export const splitTransactionTable: Table = {
  name: SPLIT_TRANSACTIONS,
  schema: splitTransactionSchema as Schema<Record<string, unknown>>,
  constraints: splitTransactionConstraints,
  indexes: splitTransactionIndexes,
};
