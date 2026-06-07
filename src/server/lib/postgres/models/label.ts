import { JSONLabel, isString, isNullableString, isNumber } from "common";
import {
  LABEL_ID,
  PARENT_TYPE,
  PARENT_ID,
  USER_ID,
  BUDGET_ID,
  CATEGORY_ID,
  MEMO,
  CONFIDENCE,
  UPDATED,
  LABELS,
  USERS,
  BUDGETS,
  CATEGORIES,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

/**
 * Stores transaction/account labels with their full provenance — engine
 * suggestions and user confirmations/rejections all live as rows here, keyed
 * by `(parent_id, confidence)`. The merchant signal reads every confidence
 * for a merchant's transactions; the transaction/account read paths take
 * `MAX(confidence)` per parent.
 *
 * `parent_type` discriminates between transaction and account parents — the
 * FK can't be enforced in Postgres without table-per-parent, but `user_id`
 * scoping + the parent-table FK on the *other* side (transactions /
 * accounts both reference users) keeps the rows recoverable.
 */
const labelSchema = {
  [LABEL_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [PARENT_TYPE]: "VARCHAR(16) NOT NULL",
  // parent_id is `transactions.transaction_id` (VARCHAR(255)) OR
  // `accounts.account_id` (VARCHAR(255)) depending on parent_type — both
  // tables' PKs are VARCHAR, not UUID, so this column matches the wider type
  // to keep the polymorphic INSERT … SELECT (and any future FK lookup) clean.
  [PARENT_ID]: "VARCHAR(255) NOT NULL",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE NOT NULL`,
  [BUDGET_ID]: `UUID REFERENCES ${BUDGETS}(${BUDGET_ID}) ON DELETE SET NULL`,
  [CATEGORY_ID]: `UUID REFERENCES ${CATEGORIES}(${CATEGORY_ID}) ON DELETE SET NULL`,
  [MEMO]: "TEXT",
  [CONFIDENCE]: "FLOAT NOT NULL",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type LabelSchema = typeof labelSchema;
type LabelRow = { [k in keyof LabelSchema]: RowValueType };

export class LabelModel extends Model<JSONLabel, LabelSchema> implements LabelRow {
  declare label_id: string;
  declare parent_type: string;
  declare parent_id: string;
  declare user_id: string;
  declare budget_id: string | null;
  declare category_id: string | null;
  declare memo: string | null;
  declare confidence: number;
  declare updated: string | null;

  static typeChecker = {
    label_id: isString,
    parent_type: isString,
    parent_id: isString,
    user_id: isString,
    budget_id: isNullableString,
    category_id: isNullableString,
    memo: isNullableString,
    confidence: isNumber,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, LabelModel.typeChecker);
  }

  toJSON(): JSONLabel {
    return {
      label_id: this.label_id,
      parent_type: this.parent_type as "transaction" | "account",
      parent_id: this.parent_id,
      memo: this.memo,
      budget_id: this.budget_id,
      category_id: this.category_id,
      confidence: this.confidence,
    };
  }
}

export const labelsTable = createTable({
  name: LABELS,
  primaryKey: LABEL_ID,
  schema: labelSchema,
  // `(parent_id, confidence)` is the natural uniqueness — Hoie's design lets a
  // parent carry multiple labels (one per confidence tier) but never two at
  // the same confidence. Engine writes go to a fractional confidence; user
  // writes go to 0.0 (rejected) or 1.0 (confirmed). UPSERT on this key lets
  // the engine re-suggest without piling rows.
  constraints: [`UNIQUE (${PARENT_ID}, ${CONFIDENCE})`],
  indexes: [
    { column: PARENT_ID },
    { column: USER_ID },
  ],
  ModelClass: LabelModel,
  supportsSoftDelete: false,
});

export const labelColumns = Object.keys(labelsTable.schema);
