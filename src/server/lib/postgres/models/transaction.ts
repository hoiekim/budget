import { TransactionPaymentChannelEnum } from "plaid";
import {
  JSONTransaction, LocalDate, isString, isUndefined,
  isNullableString, isNullableNumber, isNullableBoolean, isNullableDate, isNullableObject,
} from "common";
import {
  TRANSACTION_ID, USER_ID, ACCOUNT_ID, NAME, MERCHANT_NAME, AMOUNT, ISO_CURRENCY_CODE, DATE,
  PENDING, PENDING_TRANSACTION_ID, PAYMENT_CHANNEL, LOCATION_COUNTRY, LOCATION_REGION,
  LOCATION_CITY, LABEL_BUDGET_ID, LABEL_CATEGORY_ID, LABEL_MEMO, RAW, UPDATED, IS_DELETED,
  TRANSACTIONS, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class TransactionModel extends Model<JSONTransaction> {
  transaction_id!: string; user_id!: string; account_id!: string; name!: string; merchant_name!: string | null;
  amount!: number; iso_currency_code!: string | null; date!: string; pending!: boolean;
  pending_transaction_id!: string | null; payment_channel!: TransactionPaymentChannelEnum;
  location_country!: string | null; location_region!: string | null; location_city!: string | null;
  label_budget_id!: string | null; label_category_id!: string | null; label_memo!: string | null;
  updated!: Date; is_deleted!: boolean;

  static typeChecker = {
    transaction_id: isString, user_id: isString, account_id: isString, name: isNullableString,
    merchant_name: isNullableString, amount: isNullableNumber, iso_currency_code: isNullableString,
    date: isNullableDate, pending: isNullableBoolean, pending_transaction_id: isNullableString,
    payment_channel: isNullableString, location_country: isNullableString, location_region: isNullableString,
    location_city: isNullableString, label_budget_id: isNullableString, label_category_id: isNullableString,
    label_memo: isNullableString, raw: isNullableObject, updated: isNullableDate, is_deleted: isNullableBoolean,
  };

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("TransactionModel", TransactionModel.typeChecker);

  constructor(data: unknown) {
    super();
    TransactionModel.assertType(data);
    const r = data as Record<string, unknown>;
    Object.keys(TransactionModel.typeChecker).forEach((k) => {
      (this as Record<string, unknown>)[k] = r[k];
    });
    // Type conversion: DATE column returns as Date object, need ISO string
    this.date = (this.date as unknown as Date).toISOString().split("T")[0];
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

  static toRow(tx: Partial<JSONTransaction> & { transaction_id: string }, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
    if (!isUndefined(tx.transaction_id)) r.transaction_id = tx.transaction_id;
    if (!isUndefined(tx.account_id)) r.account_id = tx.account_id;
    if (!isUndefined(tx.name)) r.name = tx.name;
    if (!isUndefined(tx.merchant_name)) r.merchant_name = tx.merchant_name;
    if (!isUndefined(tx.amount)) r.amount = tx.amount;
    if (!isUndefined(tx.iso_currency_code)) r.iso_currency_code = tx.iso_currency_code;
    if (!isUndefined(tx.authorized_date || tx.date)) r.date = new LocalDate((tx.authorized_date || tx.date)!);
    if (!isUndefined(tx.pending)) r.pending = tx.pending;
    if (!isUndefined(tx.pending_transaction_id)) r.pending_transaction_id = tx.pending_transaction_id;
    if (!isUndefined(tx.payment_channel)) r.payment_channel = tx.payment_channel;
    if (tx.location) {
      if (!isUndefined(tx.location.country)) r.location_country = tx.location.country;
      if (!isUndefined(tx.location.region)) r.location_region = tx.location.region;
      if (!isUndefined(tx.location.city)) r.location_city = tx.location.city;
    }
    if (tx.label) {
      if (!isUndefined(tx.label.budget_id)) r.label_budget_id = tx.label.budget_id;
      if (!isUndefined(tx.label.category_id)) r.label_category_id = tx.label.category_id;
      if (!isUndefined(tx.label.memo)) r.label_memo = tx.label.memo;
    }
    const { label, ...providerData } = tx;
    r.raw = providerData;
    return r;
  }
}

export const transactionsTable = createTable({
  name: TRANSACTIONS,
  primaryKey: TRANSACTION_ID,
  schema: {
    [TRANSACTION_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [ACCOUNT_ID]: "VARCHAR(255) NOT NULL", [NAME]: "TEXT", [MERCHANT_NAME]: "TEXT",
    [AMOUNT]: "DECIMAL(15, 2)", [ISO_CURRENCY_CODE]: "VARCHAR(10)", [DATE]: "DATE NOT NULL",
    [PENDING]: "BOOLEAN DEFAULT FALSE", [PENDING_TRANSACTION_ID]: "VARCHAR(255)", [PAYMENT_CHANNEL]: "TEXT",
    [LOCATION_COUNTRY]: "TEXT", [LOCATION_REGION]: "TEXT", [LOCATION_CITY]: "TEXT",
    [LABEL_BUDGET_ID]: "UUID", [LABEL_CATEGORY_ID]: "UUID", [LABEL_MEMO]: "TEXT", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: ACCOUNT_ID }, { column: DATE }, { column: PENDING }],
  ModelClass: TransactionModel,
});

export const transactionColumns = Object.keys(transactionsTable.schema);
