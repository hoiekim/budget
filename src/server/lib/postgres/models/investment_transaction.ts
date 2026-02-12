import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import {
  JSONInvestmentTransaction as JSONInvTx,
  isString,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
  isNullableObject,
} from "common";
import {
  INVESTMENT_TRANSACTION_ID,
  USER_ID,
  ACCOUNT_ID,
  SECURITY_ID,
  DATE,
  NAME,
  AMOUNT,
  QUANTITY,
  PRICE,
  ISO_CURRENCY_CODE,
  TYPE,
  SUBTYPE,
  LABEL_BUDGET_ID,
  LABEL_CATEGORY_ID,
  LABEL_MEMO,
  RAW,
  UPDATED,
  IS_DELETED,
  INVESTMENT_TRANSACTIONS,
  USERS,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const invTxSchema = {
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

type InvTxSchema = typeof invTxSchema;
type InvTxRow = { [k in keyof InvTxSchema]: RowValueType };

export class InvTxModel extends Model<JSONInvTx, InvTxSchema> implements InvTxRow {
  investment_transaction_id!: string;
  user_id!: string;
  account_id!: string;
  security_id!: string | null;
  date!: string;
  name!: string;
  amount!: number;
  quantity!: number;
  price!: number;
  iso_currency_code!: string | null;
  type!: InvestmentTransactionType;
  subtype!: InvestmentTransactionSubtype;
  label_budget_id!: string | null;
  label_category_id!: string | null;
  label_memo!: string | null;
  raw!: object | null;
  updated!: string | null;
  is_deleted!: boolean;

  static typeChecker = {
    investment_transaction_id: isString,
    user_id: isString,
    account_id: isString,
    security_id: isNullableString,
    date: isString,
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
    raw: isNullableObject,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, InvTxModel.typeChecker);
  }

  toJSON(): JSONInvTx {
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
    tx: Partial<JSONInvTx> & { investment_transaction_id: string },
    user_id: string,
  ): Partial<InvTxRow> {
    const r: Partial<InvTxRow> = { user_id };
    if (tx.investment_transaction_id !== undefined)
      r.investment_transaction_id = tx.investment_transaction_id;
    if (tx.account_id !== undefined) r.account_id = tx.account_id;
    if (tx.security_id !== undefined) r.security_id = tx.security_id;
    if (tx.date !== undefined) r.date = tx.date;
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
  schema: invTxSchema,
  indexes: [{ column: USER_ID }, { column: ACCOUNT_ID }, { column: DATE }],
  ModelClass: InvTxModel,
});

export const investmentTransactionColumns = Object.keys(investmentTransactionsTable.schema);
