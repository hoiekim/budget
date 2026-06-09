import { JSONSuggestion, isString, isNumber } from "common";
import {
  TRANSACTION_ID,
  USER_ID,
  CATEGORY_ID,
  CONFIDENCE,
  IS_CONFIRMED,
  IS_REJECTED,
  CONFIRMED_AT,
  ENGINE_SCORED_AT,
  UPDATED,
  SUGGESTIONS,
  TRANSACTIONS,
  USERS,
  CATEGORIES,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

/**
 * Stores per-(transaction, category) label history for engine learning.
 *
 * Loosely coupled with the transaction: `transactions.label_*` is the
 * denormalized "current label" cache used by every transaction read; the
 * `suggestions` table is the engine's event log, read only by
 * `getMerchantSignal` to compute the confirm/reject rate per merchant.
 *
 * Composite PRIMARY KEY on `(transaction_id, category_id)` — at most one row
 * per pair. Lifecycle is tracked by two explicit user-action flags
 * (`is_confirmed`, `is_rejected`) so the merchant signal never has to infer
 * user intent from `confidence` alone.
 */
const suggestionSchema = {
  // transactions.transaction_id is VARCHAR(255). The FK keeps suggestion rows
  // bound to a real transaction and cascades on transaction delete.
  [TRANSACTION_ID]: `VARCHAR(255) REFERENCES ${TRANSACTIONS}(${TRANSACTION_ID}) ON DELETE CASCADE NOT NULL`,
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE NOT NULL`,
  // category_id is part of the composite PK — must be NOT NULL.
  [CATEGORY_ID]: `UUID REFERENCES ${CATEGORIES}(${CATEGORY_ID}) ON DELETE CASCADE NOT NULL`,
  [CONFIDENCE]: "FLOAT NOT NULL",
  [IS_CONFIRMED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [IS_REJECTED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [CONFIRMED_AT]: "TIMESTAMPTZ",
  [ENGINE_SCORED_AT]: "TIMESTAMPTZ",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type SuggestionSchema = typeof suggestionSchema;
type SuggestionRow = { [k in keyof SuggestionSchema]: RowValueType };

export class SuggestionModel
  extends Model<JSONSuggestion, SuggestionSchema>
  implements SuggestionRow
{
  declare transaction_id: string;
  declare user_id: string;
  declare category_id: string;
  declare confidence: number;
  declare is_confirmed: boolean;
  declare is_rejected: boolean;
  declare confirmed_at: string | null;
  declare engine_scored_at: string | null;
  declare updated: string | null;

  static typeChecker = {
    transaction_id: isString,
    user_id: isString,
    category_id: isString,
    confidence: isNumber,
    is_confirmed: isBoolean,
    is_rejected: isBoolean,
    confirmed_at: isNullableString,
    engine_scored_at: isNullableString,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, SuggestionModel.typeChecker);
  }

  toJSON(): JSONSuggestion {
    return {
      transaction_id: this.transaction_id,
      category_id: this.category_id,
      confidence: this.confidence,
      is_confirmed: this.is_confirmed,
      is_rejected: this.is_rejected,
      confirmed_at: this.confirmed_at,
      engine_scored_at: this.engine_scored_at,
    };
  }
}

export const suggestionsTable = createTable({
  name: SUGGESTIONS,
  // Composite primary key; the Table framework requires a single-column
  // `primaryKey` field for its built-in CRUD helpers, none of which the
  // suggestions repository uses (all writes go through raw SQL in
  // `repositories/suggestions.ts`). Setting `primaryKey` here satisfies the
  // abstract field without claiming any single column is the row key.
  primaryKey: TRANSACTION_ID,
  schema: suggestionSchema,
  constraints: [
    `PRIMARY KEY (${TRANSACTION_ID}, ${CATEGORY_ID})`,
    // Mutual exclusion of the two user-action flags. Enforced at the schema
    // level so a future batch UPDATE that sets one flag without clearing
    // the other can't produce contradictory rows.
    `CHECK (NOT (${IS_CONFIRMED} AND ${IS_REJECTED}))`,
  ],
  indexes: [{ column: TRANSACTION_ID }, { column: USER_ID }],
  ModelClass: SuggestionModel,
  supportsSoftDelete: false,
});

export const suggestionColumns = Object.keys(suggestionsTable.schema);
