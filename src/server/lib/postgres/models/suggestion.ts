import { JSONSuggestion, isString, isNumber } from "common";
import {
  SUGGESTION_ID,
  TRANSACTION_ID,
  USER_ID,
  CATEGORY_ID,
  CONFIDENCE,
  UPDATED,
  SUGGESTIONS,
  TRANSACTIONS,
  USERS,
  CATEGORIES,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

/**
 * Stores per-(transaction, category) label history for engine learning.
 *
 * Loosely coupled with the transaction: `transactions.label_*` is the
 * denormalized "current label" cache used by every transaction read; the
 * `suggestions` table is the engine's event log, read only by
 * `getMerchantSignal` to compute the confirm/reject rate per merchant.
 *
 * At most one row exists per `(transaction_id, category_id)` pair — the
 * UNIQUE constraint enforces it. Each row's `confidence` reflects the
 * latest state for that pair:
 *
 * - `confidence = 1`: user-confirmed this category
 * - `0 < confidence < 1`: engine's most recent suggestion score
 * - `confidence = 0`: user rejected this category
 *
 * The engine's write path UPSERTs at strict-fractional confidence with a
 * `WHERE suggestions.confidence < 1 AND suggestions.confidence > 0` guard
 * so it never clobbers a user confirmation (1) or rejection (0).
 */
const suggestionSchema = {
  [SUGGESTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  // transactions.transaction_id is VARCHAR(255). The FK keeps suggestion rows
  // bound to a real transaction and cascades on transaction delete.
  [TRANSACTION_ID]: `VARCHAR(255) REFERENCES ${TRANSACTIONS}(${TRANSACTION_ID}) ON DELETE CASCADE NOT NULL`,
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE NOT NULL`,
  // category_id is part of the UNIQUE key and the whole point of the table —
  // a row without a category carries no engine-learnable signal, so NOT NULL.
  [CATEGORY_ID]: `UUID REFERENCES ${CATEGORIES}(${CATEGORY_ID}) ON DELETE CASCADE NOT NULL`,
  [CONFIDENCE]: "FLOAT NOT NULL",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type SuggestionSchema = typeof suggestionSchema;
type SuggestionRow = { [k in keyof SuggestionSchema]: RowValueType };

export class SuggestionModel
  extends Model<JSONSuggestion, SuggestionSchema>
  implements SuggestionRow
{
  declare suggestion_id: string;
  declare transaction_id: string;
  declare user_id: string;
  declare category_id: string;
  declare confidence: number;
  declare updated: string | null;

  static typeChecker = {
    suggestion_id: isString,
    transaction_id: isString,
    user_id: isString,
    category_id: isString,
    confidence: isNumber,
    updated: (v: unknown): v is string | null => v === null || typeof v === "string",
  };

  constructor(data: unknown) {
    super(data, SuggestionModel.typeChecker);
  }

  toJSON(): JSONSuggestion {
    return {
      suggestion_id: this.suggestion_id,
      transaction_id: this.transaction_id,
      category_id: this.category_id,
      confidence: this.confidence,
    };
  }
}

export const suggestionsTable = createTable({
  name: SUGGESTIONS,
  primaryKey: SUGGESTION_ID,
  schema: suggestionSchema,
  // UNIQUE(transaction_id, category_id) — at most one row per pair. The
  // engine and the user both write into this same row; confidence transitions
  // (0 → 0.x → 1 → 0 → …) capture the lifecycle without duplicating rows.
  constraints: [`UNIQUE (${TRANSACTION_ID}, ${CATEGORY_ID})`],
  indexes: [{ column: TRANSACTION_ID }, { column: USER_ID }],
  ModelClass: SuggestionModel,
  supportsSoftDelete: false,
});

export const suggestionColumns = Object.keys(suggestionsTable.schema);
