import { JSONRejectedCategory, isString } from "common";
import {
  TRANSACTION_ID,
  USER_ID,
  CATEGORY_ID,
  REJECTED_AT,
  REJECTED_CATEGORIES,
  TRANSACTIONS,
  USERS,
  CATEGORIES,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

/**
 * Stores every (transaction, category) pair the user has explicitly
 * rejected. Read by the auto-suggest engine's merchant signal — see
 * `getMerchantSignal` — to downweight categories the user keeps saying
 * no to.
 *
 * Composite PRIMARY KEY on `(transaction_id, category_id)` — at most one
 * row per pair. Other tables only carry the current state; this table
 * exists *because* the legacy denorm columns can't carry rejection
 * history (`transactions.label_category_id` is a single current label,
 * not a sequence).
 *
 * Confirmations and engine ephemeral scores intentionally live elsewhere
 * (`transactions.label_category_id` + `label_category_confidence`) — see
 * `JSONRejectedCategory`'s docstring for the rationale.
 */
const rejectedCategorySchema = {
  // transactions.transaction_id is VARCHAR(255). The FK keeps rejection
  // rows bound to a real transaction and cascades on transaction delete.
  [TRANSACTION_ID]: `VARCHAR(255) REFERENCES ${TRANSACTIONS}(${TRANSACTION_ID}) ON DELETE CASCADE NOT NULL`,
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE NOT NULL`,
  // category_id is part of the composite PK — must be NOT NULL.
  [CATEGORY_ID]: `UUID REFERENCES ${CATEGORIES}(${CATEGORY_ID}) ON DELETE CASCADE NOT NULL`,
  [REJECTED_AT]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type RejectedCategorySchema = typeof rejectedCategorySchema;
type RejectedCategoryRow = { [k in keyof RejectedCategorySchema]: RowValueType };

export class RejectedCategoryModel
  extends Model<JSONRejectedCategory, RejectedCategorySchema>
  implements RejectedCategoryRow
{
  declare transaction_id: string;
  declare user_id: string;
  declare category_id: string;
  declare rejected_at: string | null;

  static typeChecker = {
    transaction_id: isString,
    user_id: isString,
    category_id: isString,
    rejected_at: isNullableString,
  };

  constructor(data: unknown) {
    super(data, RejectedCategoryModel.typeChecker);
  }

  toJSON(): JSONRejectedCategory {
    return {
      transaction_id: this.transaction_id,
      category_id: this.category_id,
      rejected_at: this.rejected_at,
    };
  }
}

export const rejectedCategoriesTable = createTable({
  name: REJECTED_CATEGORIES,
  // Composite primary key; the Table framework requires a single-column
  // `primaryKey` field for its built-in CRUD helpers, none of which the
  // rejected-categories repository uses (all writes go through raw SQL).
  // The runtime guard `_assertSimplePrimaryKey` (added with #496's review
  // pass) throws if a future contributor reaches for those generic
  // helpers on this table.
  primaryKey: TRANSACTION_ID,
  schema: rejectedCategorySchema,
  constraints: [`PRIMARY KEY (${TRANSACTION_ID}, ${CATEGORY_ID})`],
  indexes: [{ column: USER_ID }],
  ModelClass: RejectedCategoryModel,
  supportsSoftDelete: false,
});

export const rejectedCategoryColumns = Object.keys(rejectedCategoriesTable.schema);
