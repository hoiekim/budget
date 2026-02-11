import {
  TransactionPaymentChannelEnum, InvestmentTransactionType, InvestmentTransactionSubtype,
} from "plaid";
import {
  JSONTransaction, JSONInvestmentTransaction, JSONSplitTransaction, LocalDate, isString, isUndefined,
  isNullableString, isNullableNumber, isNullableBoolean, isNullableDate, isNullableObject,
} from "common";
import {
  TRANSACTION_ID, USER_ID, ACCOUNT_ID, NAME, MERCHANT_NAME, AMOUNT, ISO_CURRENCY_CODE, DATE,
  PENDING, PENDING_TRANSACTION_ID, PAYMENT_CHANNEL, LOCATION_COUNTRY, LOCATION_REGION,
  LOCATION_CITY, LABEL_BUDGET_ID, LABEL_CATEGORY_ID, LABEL_MEMO, RAW, UPDATED, IS_DELETED,
  INVESTMENT_TRANSACTION_ID, SECURITY_ID, QUANTITY, PRICE, TYPE, SUBTYPE, SPLIT_TRANSACTION_ID,
  CUSTOM_NAME, TRANSACTIONS, INVESTMENT_TRANSACTIONS, SPLIT_TRANSACTIONS, USERS,
} from "./common";
import { Schema, Constraints, IndexDefinition, Table, AssertTypeFn, createAssertType, Model } from "./base";
import { toDate, toNullableNumber, toISODateString } from "../util";

export class TransactionModel extends Model<JSONTransaction> {
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

  constructor(data: unknown) {
    super();
    TransactionModel.assertType(data);
    const row = data as Record<string, unknown>;
    this.transaction_id = row.transaction_id as string;
    this.user_id = row.user_id as string;
    this.account_id = row.account_id as string;
    this.name = (row.name as string) || "Unknown";
    this.merchant_name = (row.merchant_name as string) ?? null;
    this.amount = toNullableNumber(row.amount) ?? 0;
    this.iso_currency_code = (row.iso_currency_code as string) ?? null;
    this.date = toISODateString(row.date);
    this.pending = (row.pending as boolean) ?? false;
    this.pending_transaction_id = (row.pending_transaction_id as string) ?? null;
    this.payment_channel = (row.payment_channel as TransactionPaymentChannelEnum) || TransactionPaymentChannelEnum.InStore;
    this.location_country = (row.location_country as string) ?? null;
    this.location_region = (row.location_region as string) ?? null;
    this.location_city = (row.location_city as string) ?? null;
    this.label_budget_id = (row.label_budget_id as string) ?? null;
    this.label_category_id = (row.label_category_id as string) ?? null;
    this.label_memo = (row.label_memo as string) ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONTransaction {
    return {
      transaction_id: this.transaction_id, account_id: this.account_id, name: this.name,
      merchant_name: this.merchant_name, amount: this.amount, iso_currency_code: this.iso_currency_code,
      date: this.date, pending: this.pending, pending_transaction_id: this.pending_transaction_id,
      payment_channel: this.payment_channel,
      label: { budget_id: this.label_budget_id, category_id: this.label_category_id, memo: this.label_memo },
      location: { address: null, city: this.location_city, region: this.location_region, postal_code: null,
        country: this.location_country, store_number: null, lat: null, lon: null },
      payment_meta: { reference_number: null, ppd_id: null, payee: null, by_order_of: null, payer: null,
        payment_method: null, payment_processor: null, reason: null },
      category_id: null, category: null, account_owner: null, unofficial_currency_code: null,
      authorized_date: null, authorized_datetime: null, datetime: null, transaction_code: null,
    };
  }

  static fromJSON(tx: Partial<JSONTransaction> & { transaction_id: string }, user_id: string): Record<string, unknown> {
    const row: Record<string, unknown> = { user_id };
    if (!isUndefined(tx.transaction_id)) row.transaction_id = tx.transaction_id;
    if (!isUndefined(tx.account_id)) row.account_id = tx.account_id;
    if (!isUndefined(tx.name)) row.name = tx.name;
    if (!isUndefined(tx.merchant_name)) row.merchant_name = tx.merchant_name;
    if (!isUndefined(tx.amount)) row.amount = tx.amount;
    if (!isUndefined(tx.iso_currency_code)) row.iso_currency_code = tx.iso_currency_code;
    if (!isUndefined(tx.authorized_date || tx.date)) row.date = new LocalDate((tx.authorized_date || tx.date)!);
    if (!isUndefined(tx.pending)) row.pending = tx.pending;
    if (!isUndefined(tx.pending_transaction_id)) row.pending_transaction_id = tx.pending_transaction_id;
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
    const { label, ...providerData } = tx;
    row.raw = providerData;
    return row;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("TransactionModel", {
    transaction_id: isString, user_id: isString, account_id: isString, name: isNullableString,
    merchant_name: isNullableString, amount: isNullableNumber, iso_currency_code: isNullableString,
    date: isNullableDate, pending: isNullableBoolean, pending_transaction_id: isNullableString,
    payment_channel: isNullableString, location_country: isNullableString, location_region: isNullableString,
    location_city: isNullableString, label_budget_id: isNullableString, label_category_id: isNullableString,
    label_memo: isNullableString, raw: isNullableObject, updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export class TransactionsTable extends Table<JSONTransaction, TransactionModel> {
  readonly name = TRANSACTIONS;
  readonly schema: Schema<Record<string, unknown>> = {
    [TRANSACTION_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [ACCOUNT_ID]: "VARCHAR(255) NOT NULL", [NAME]: "TEXT", [MERCHANT_NAME]: "TEXT",
    [AMOUNT]: "DECIMAL(15, 2)", [ISO_CURRENCY_CODE]: "VARCHAR(10)", [DATE]: "DATE NOT NULL",
    [PENDING]: "BOOLEAN DEFAULT FALSE", [PENDING_TRANSACTION_ID]: "VARCHAR(255)", [PAYMENT_CHANNEL]: "TEXT",
    [LOCATION_COUNTRY]: "TEXT", [LOCATION_REGION]: "TEXT", [LOCATION_CITY]: "TEXT",
    [LABEL_BUDGET_ID]: "UUID", [LABEL_CATEGORY_ID]: "UUID", [LABEL_MEMO]: "TEXT", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  };
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [{ column: USER_ID }, { column: ACCOUNT_ID }, { column: DATE }, { column: PENDING }];
  readonly ModelClass = TransactionModel;
}
export const transactionsTable = new TransactionsTable();
export const transactionColumns = Object.keys(transactionsTable.schema);

export class InvestmentTransactionModel extends Model<JSONInvestmentTransaction> {
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

  constructor(data: unknown) {
    super();
    InvestmentTransactionModel.assertType(data);
    const row = data as Record<string, unknown>;
    this.investment_transaction_id = row.investment_transaction_id as string;
    this.user_id = row.user_id as string;
    this.account_id = row.account_id as string;
    this.security_id = (row.security_id as string) ?? null;
    this.date = toISODateString(row.date);
    this.name = (row.name as string) || "Unknown";
    this.amount = toNullableNumber(row.amount) ?? 0;
    this.quantity = toNullableNumber(row.quantity) ?? 0;
    this.price = toNullableNumber(row.price) ?? 0;
    this.iso_currency_code = (row.iso_currency_code as string) ?? null;
    this.type = (row.type as InvestmentTransactionType) || InvestmentTransactionType.Transfer;
    this.subtype = (row.subtype as InvestmentTransactionSubtype) || InvestmentTransactionSubtype.Transfer;
    this.label_budget_id = (row.label_budget_id as string) ?? null;
    this.label_category_id = (row.label_category_id as string) ?? null;
    this.label_memo = (row.label_memo as string) ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONInvestmentTransaction {
    return {
      investment_transaction_id: this.investment_transaction_id, account_id: this.account_id,
      security_id: this.security_id, date: this.date, name: this.name, quantity: this.quantity,
      amount: this.amount, price: this.price, iso_currency_code: this.iso_currency_code,
      type: this.type, subtype: this.subtype, fees: null, unofficial_currency_code: null,
      label: { budget_id: this.label_budget_id, category_id: this.label_category_id, memo: this.label_memo },
    };
  }

  static fromJSON(tx: Partial<JSONInvestmentTransaction> & { investment_transaction_id: string }, user_id: string): Record<string, unknown> {
    const row: Record<string, unknown> = { user_id };
    if (tx.investment_transaction_id !== undefined) row.investment_transaction_id = tx.investment_transaction_id;
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
    row.raw = providerData;
    return row;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("InvestmentTransactionModel", {
    investment_transaction_id: isString, user_id: isString, account_id: isString, security_id: isNullableString,
    date: isNullableDate, name: isNullableString, amount: isNullableNumber, quantity: isNullableNumber,
    price: isNullableNumber, iso_currency_code: isNullableString, type: isNullableString, subtype: isNullableString,
    label_budget_id: isNullableString, label_category_id: isNullableString, label_memo: isNullableString,
    raw: isNullableObject, updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export class InvestmentTransactionsTable extends Table<JSONInvestmentTransaction, InvestmentTransactionModel> {
  readonly name = INVESTMENT_TRANSACTIONS;
  readonly schema: Schema<Record<string, unknown>> = {
    [INVESTMENT_TRANSACTION_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [ACCOUNT_ID]: "VARCHAR(255) NOT NULL", [SECURITY_ID]: "VARCHAR(255)", [DATE]: "DATE NOT NULL",
    [NAME]: "TEXT", [AMOUNT]: "DECIMAL(15, 2)", [QUANTITY]: "DECIMAL(15, 6)", [PRICE]: "DECIMAL(15, 6)",
    [ISO_CURRENCY_CODE]: "VARCHAR(10)", [TYPE]: "TEXT", [SUBTYPE]: "TEXT",
    [LABEL_BUDGET_ID]: "UUID", [LABEL_CATEGORY_ID]: "UUID", [LABEL_MEMO]: "TEXT", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  };
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [{ column: USER_ID }, { column: ACCOUNT_ID }, { column: DATE }];
  readonly ModelClass = InvestmentTransactionModel;
}
export const investmentTransactionsTable = new InvestmentTransactionsTable();
export const investmentTransactionColumns = Object.keys(investmentTransactionsTable.schema);

export class SplitTransactionModel extends Model<JSONSplitTransaction> {
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

  constructor(data: unknown) {
    super();
    SplitTransactionModel.assertType(data);
    const row = data as Record<string, unknown>;
    this.split_transaction_id = row.split_transaction_id as string;
    this.user_id = row.user_id as string;
    this.transaction_id = row.transaction_id as string;
    this.account_id = row.account_id as string;
    this.amount = toNullableNumber(row.amount) ?? 0;
    this.date = toISODateString(row.date);
    this.custom_name = (row.custom_name as string) || "";
    this.label_budget_id = (row.label_budget_id as string) ?? null;
    this.label_category_id = (row.label_category_id as string) ?? null;
    this.label_memo = (row.label_memo as string) ?? null;
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONSplitTransaction {
    return {
      split_transaction_id: this.split_transaction_id, transaction_id: this.transaction_id,
      account_id: this.account_id, amount: this.amount, date: this.date, custom_name: this.custom_name,
      label: { budget_id: this.label_budget_id, category_id: this.label_category_id, memo: this.label_memo },
    };
  }

  static fromJSON(tx: Partial<JSONSplitTransaction>, user_id: string): Record<string, unknown> {
    const row: Record<string, unknown> = { user_id };
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

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SplitTransactionModel", {
    split_transaction_id: isString, user_id: isString, transaction_id: isString, account_id: isString,
    amount: isNullableNumber, date: isNullableDate, custom_name: isNullableString,
    label_budget_id: isNullableString, label_category_id: isNullableString, label_memo: isNullableString,
    updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export class SplitTransactionsTable extends Table<JSONSplitTransaction, SplitTransactionModel> {
  readonly name = SPLIT_TRANSACTIONS;
  readonly schema: Schema<Record<string, unknown>> = {
    [SPLIT_TRANSACTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [TRANSACTION_ID]: "VARCHAR(255) NOT NULL", [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
    [AMOUNT]: "DECIMAL(15, 2) DEFAULT 0", [DATE]: "DATE NOT NULL", [CUSTOM_NAME]: "TEXT DEFAULT ''",
    [LABEL_BUDGET_ID]: "UUID", [LABEL_CATEGORY_ID]: "UUID", [LABEL_MEMO]: "TEXT",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  };
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [{ column: USER_ID }, { column: TRANSACTION_ID }, { column: ACCOUNT_ID }];
  readonly ModelClass = SplitTransactionModel;
}
export const splitTransactionsTable = new SplitTransactionsTable();
export const splitTransactionColumns = Object.keys(splitTransactionsTable.schema);
