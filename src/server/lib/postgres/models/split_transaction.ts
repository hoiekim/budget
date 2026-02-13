import {
  JSONSplitTransaction,
  isString,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
} from "common";
import {
  SPLIT_TRANSACTION_ID,
  USER_ID,
  TRANSACTION_ID,
  ACCOUNT_ID,
  AMOUNT,
  DATE,
  CUSTOM_NAME,
  LABEL_BUDGET_ID,
  LABEL_CATEGORY_ID,
  LABEL_MEMO,
  UPDATED,
  IS_DELETED,
  SPLIT_TRANSACTIONS,
  USERS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const splitTxSchema = {
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

type SplitTxSchema = typeof splitTxSchema;
type SplitTxRow = { [k in keyof SplitTxSchema]: RowValueType };

export class SplitTransactionModel extends Model<JSONSplitTransaction, SplitTxSchema> implements SplitTxRow {
  declare split_transaction_id: string;
  declare user_id: string;
  declare transaction_id: string;
  declare account_id: string;
  declare amount: number;
  declare date: string | null;
  declare custom_name: string;
  declare label_budget_id: string | null;
  declare label_category_id: string | null;
  declare label_memo: string | null;
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    split_transaction_id: isString,
    user_id: isString,
    transaction_id: isString,
    account_id: isString,
    amount: isNullableNumber,
    date: isNullableString,
    custom_name: isNullableString,
    label_budget_id: isNullableString,
    label_category_id: isNullableString,
    label_memo: isNullableString,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, SplitTransactionModel.typeChecker);
  }

  toJSON(): JSONSplitTransaction {
    return {
      split_transaction_id: this.split_transaction_id,
      transaction_id: this.transaction_id,
      account_id: this.account_id,
      amount: this.amount,
      date: this.date || undefined,
      custom_name: this.custom_name,
      label: {
        budget_id: this.label_budget_id,
        category_id: this.label_category_id,
        memo: this.label_memo,
      },
    };
  }

  static fromJSON(tx: Partial<JSONSplitTransaction>, user_id: string): Partial<SplitTxRow> {
    const r: Partial<SplitTxRow> = { user_id };
    if (tx.split_transaction_id !== undefined) r.split_transaction_id = tx.split_transaction_id;
    if (tx.transaction_id !== undefined) r.transaction_id = tx.transaction_id;
    if (tx.account_id !== undefined) r.account_id = tx.account_id;
    if (tx.amount !== undefined) r.amount = tx.amount;
    if (tx.date !== undefined) r.date = tx.date;
    if (tx.custom_name !== undefined) r.custom_name = tx.custom_name;
    if (tx.label) {
      if (tx.label.budget_id !== undefined) r.label_budget_id = tx.label.budget_id;
      if (tx.label.category_id !== undefined) r.label_category_id = tx.label.category_id;
      if (tx.label.memo !== undefined) r.label_memo = tx.label.memo;
    }
    return r;
  }
}

export const splitTransactionsTable = createTable({
  name: SPLIT_TRANSACTIONS,
  primaryKey: SPLIT_TRANSACTION_ID,
  schema: splitTxSchema,
  indexes: [{ column: USER_ID }, { column: TRANSACTION_ID }, { column: ACCOUNT_ID }],
  ModelClass: SplitTransactionModel,
});

export const splitTransactionColumns = Object.keys(splitTransactionsTable.schema);
