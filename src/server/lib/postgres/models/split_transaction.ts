import {
  JSONSplitTransaction, LocalDate, isString,
  isNullableString, isNullableNumber, isNullableBoolean, isNullableDate,
} from "common";
import {
  SPLIT_TRANSACTION_ID, USER_ID, TRANSACTION_ID, ACCOUNT_ID, AMOUNT, DATE, CUSTOM_NAME,
  LABEL_BUDGET_ID, LABEL_CATEGORY_ID, LABEL_MEMO, UPDATED, IS_DELETED, SPLIT_TRANSACTIONS, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class SplitTransactionModel extends Model<JSONSplitTransaction> {
  split_transaction_id: string; user_id: string; transaction_id: string; account_id: string;
  amount: number; date: string; custom_name: string;
  label_budget_id: string | null; label_category_id: string | null; label_memo: string | null;
  updated: Date; is_deleted: boolean;

  constructor(data: unknown) {
    super();
    SplitTransactionModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.split_transaction_id = r.split_transaction_id as string;
    this.user_id = r.user_id as string;
    this.transaction_id = r.transaction_id as string;
    this.account_id = r.account_id as string;
    this.amount = (r.amount as number) ?? 0;
    this.date = (r.date as Date).toISOString().split("T")[0];
    this.custom_name = (r.custom_name as string) || "";
    this.label_budget_id = (r.label_budget_id as string) ?? null;
    this.label_category_id = (r.label_category_id as string) ?? null;
    this.label_memo = (r.label_memo as string) ?? null;
    this.updated = (r.updated as Date) ?? new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONSplitTransaction {
    return {
      split_transaction_id: this.split_transaction_id, transaction_id: this.transaction_id,
      account_id: this.account_id, amount: this.amount, date: this.date, custom_name: this.custom_name,
      label: { budget_id: this.label_budget_id, category_id: this.label_category_id, memo: this.label_memo },
    };
  }

  static toRow(tx: Partial<JSONSplitTransaction>, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
    if (tx.split_transaction_id !== undefined) r.split_transaction_id = tx.split_transaction_id;
    if (tx.transaction_id !== undefined) r.transaction_id = tx.transaction_id;
    if (tx.account_id !== undefined) r.account_id = tx.account_id;
    if (tx.amount !== undefined) r.amount = tx.amount;
    if (tx.date !== undefined) r.date = new LocalDate(tx.date);
    if (tx.custom_name !== undefined) r.custom_name = tx.custom_name;
    if (tx.label) {
      if (tx.label.budget_id !== undefined) r.label_budget_id = tx.label.budget_id;
      if (tx.label.category_id !== undefined) r.label_category_id = tx.label.category_id;
      if (tx.label.memo !== undefined) r.label_memo = tx.label.memo;
    }
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SplitTransactionModel", {
    split_transaction_id: isString, user_id: isString, transaction_id: isString, account_id: isString,
    amount: isNullableNumber, date: isNullableDate, custom_name: isNullableString,
    label_budget_id: isNullableString, label_category_id: isNullableString, label_memo: isNullableString,
    updated: isNullableDate, is_deleted: isNullableBoolean,
  });
}

export const splitTransactionsTable = createTable({
  name: SPLIT_TRANSACTIONS,
  primaryKey: SPLIT_TRANSACTION_ID,
  schema: {
    [SPLIT_TRANSACTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [TRANSACTION_ID]: "VARCHAR(255) NOT NULL", [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
    [AMOUNT]: "DECIMAL(15, 2) DEFAULT 0", [DATE]: "DATE NOT NULL", [CUSTOM_NAME]: "TEXT DEFAULT ''",
    [LABEL_BUDGET_ID]: "UUID", [LABEL_CATEGORY_ID]: "UUID", [LABEL_MEMO]: "TEXT",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP", [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: TRANSACTION_ID }, { column: ACCOUNT_ID }],
  ModelClass: SplitTransactionModel,
});

export const splitTransactionColumns = Object.keys(splitTransactionsTable.schema);
