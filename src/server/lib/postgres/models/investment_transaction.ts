import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import {
  JSONInvestmentTransaction, LocalDate, isString,
  isNullableString, isNullableNumber, isNullableBoolean, isNullableDate, isNullableObject,
} from "common";
import {
  INVESTMENT_TRANSACTION_ID, USER_ID, ACCOUNT_ID, SECURITY_ID, DATE, NAME, AMOUNT,
  QUANTITY, PRICE, ISO_CURRENCY_CODE, TYPE, SUBTYPE, LABEL_BUDGET_ID, LABEL_CATEGORY_ID,
  LABEL_MEMO, RAW, UPDATED, IS_DELETED, INVESTMENT_TRANSACTIONS, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class InvestmentTransactionModel extends Model<JSONInvestmentTransaction> {
  investment_transaction_id: string; user_id: string; account_id: string; security_id: string | null;
  date: string; name: string; amount: number; quantity: number; price: number;
  iso_currency_code: string | null; type: InvestmentTransactionType; subtype: InvestmentTransactionSubtype;
  label_budget_id: string | null; label_category_id: string | null; label_memo: string | null;
  updated: Date; is_deleted: boolean;

  constructor(data: unknown) {
    super();
    InvestmentTransactionModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.investment_transaction_id = r.investment_transaction_id as string;
    this.user_id = r.user_id as string;
    this.account_id = r.account_id as string;
    this.security_id = (r.security_id as string) ?? null;
    this.date = (r.date as Date).toISOString().split("T")[0];
    this.name = (r.name as string) || "Unknown";
    this.amount = (r.amount as number) ?? 0;
    this.quantity = (r.quantity as number) ?? 0;
    this.price = (r.price as number) ?? 0;
    this.iso_currency_code = (r.iso_currency_code as string) ?? null;
    this.type = (r.type as InvestmentTransactionType) || InvestmentTransactionType.Transfer;
    this.subtype = (r.subtype as InvestmentTransactionSubtype) || InvestmentTransactionSubtype.Transfer;
    this.label_budget_id = (r.label_budget_id as string) ?? null;
    this.label_category_id = (r.label_category_id as string) ?? null;
    this.label_memo = (r.label_memo as string) ?? null;
    this.updated = (r.updated as Date) ?? new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
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

  static toRow(tx: Partial<JSONInvestmentTransaction> & { investment_transaction_id: string }, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
    if (tx.investment_transaction_id !== undefined) r.investment_transaction_id = tx.investment_transaction_id;
    if (tx.account_id !== undefined) r.account_id = tx.account_id;
    if (tx.security_id !== undefined) r.security_id = tx.security_id;
    if (tx.date !== undefined) r.date = new LocalDate(tx.date);
    if (tx.name !== undefined) r.name = tx.name;
    if (tx.amount !== undefined) r.amount = tx.amount;
    if (tx.quantity !== undefined) r.quantity = tx.quantity;
    if (tx.price !== undefined) r.price = tx.price;
    if (tx.iso_currency_code !== undefined) r.iso_currency_code = tx.iso_currency_code;
    if (tx.type !== undefined) r.type = tx.type;
    if (tx.subtype !== undefined) r.subtype = tx.subtype;
    if (tx.label) {
      if (tx.label.budget_id !== undefined) r.label_budget_id = tx.label.budget_id;
      if (tx.label.category_id !== undefined) r.label_category_id = tx.label.category_id;
      if (tx.label.memo !== undefined) r.label_memo = tx.label.memo;
    }
    const { label, ...providerData } = tx;
    r.raw = providerData;
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("InvestmentTransactionModel", {
    investment_transaction_id: isString, user_id: isString, account_id: isString, security_id: isNullableString,
    date: isNullableDate, name: isNullableString, amount: isNullableNumber, quantity: isNullableNumber,
    price: isNullableNumber, iso_currency_code: isNullableString, type: isNullableString, subtype: isNullableString,
    label_budget_id: isNullableString, label_category_id: isNullableString, label_memo: isNullableString,
    raw: isNullableObject, updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export const investmentTransactionsTable = createTable({
  name: INVESTMENT_TRANSACTIONS,
  primaryKey: INVESTMENT_TRANSACTION_ID,
  schema: {
    [INVESTMENT_TRANSACTION_ID]: "VARCHAR(255) PRIMARY KEY",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [ACCOUNT_ID]: "VARCHAR(255) NOT NULL", [SECURITY_ID]: "VARCHAR(255)", [DATE]: "DATE NOT NULL",
    [NAME]: "TEXT", [AMOUNT]: "DECIMAL(15, 2)", [QUANTITY]: "DECIMAL(15, 6)", [PRICE]: "DECIMAL(15, 6)",
    [ISO_CURRENCY_CODE]: "VARCHAR(10)", [TYPE]: "TEXT", [SUBTYPE]: "TEXT",
    [LABEL_BUDGET_ID]: "UUID", [LABEL_CATEGORY_ID]: "UUID", [LABEL_MEMO]: "TEXT", [RAW]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: ACCOUNT_ID }, { column: DATE }],
  ModelClass: InvestmentTransactionModel,
});

export const investmentTransactionColumns = Object.keys(investmentTransactionsTable.schema);
