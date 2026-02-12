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
  investment_transaction_id!: string; user_id!: string; account_id!: string; security_id!: string | null;
  date!: string; name!: string; amount!: number; quantity!: number; price!: number;
  iso_currency_code!: string | null; type!: InvestmentTransactionType; subtype!: InvestmentTransactionSubtype;
  label_budget_id!: string | null; label_category_id!: string | null; label_memo!: string | null;
  updated!: Date; is_deleted!: boolean;

  static typeChecker = {
    investment_transaction_id: isString, user_id: isString, account_id: isString, security_id: isNullableString,
    date: isNullableDate, name: isNullableString, amount: isNullableNumber, quantity: isNullableNumber,
    price: isNullableNumber, iso_currency_code: isNullableString, type: isNullableString, subtype: isNullableString,
    label_budget_id: isNullableString, label_category_id: isNullableString, label_memo: isNullableString,
    raw: isNullableObject, updated: isNullableDate, is_deleted: isNullableBoolean,
  };

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("InvestmentTransactionModel", InvestmentTransactionModel.typeChecker);

  constructor(data: unknown) {
    super();
    InvestmentTransactionModel.assertType(data);
    const r = data as Record<string, unknown>;
    Object.keys(InvestmentTransactionModel.typeChecker).forEach((k) => {
      (this as Record<string, unknown>)[k] = r[k];
    });
    // Apply defaults
    this.security_id = this.security_id ?? null;
    this.date = (this.date as unknown as Date).toISOString().split("T")[0];
    this.name = this.name || "Unknown";
    this.amount = this.amount ?? 0;
    this.quantity = this.quantity ?? 0;
    this.price = this.price ?? 0;
    this.iso_currency_code = this.iso_currency_code ?? null;
    this.type = this.type || InvestmentTransactionType.Transfer;
    this.subtype = this.subtype || InvestmentTransactionSubtype.Transfer;
    this.label_budget_id = this.label_budget_id ?? null;
    this.label_category_id = this.label_category_id ?? null;
    this.label_memo = this.label_memo ?? null;
    this.updated = this.updated ?? new Date();
    this.is_deleted = this.is_deleted ?? false;
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
