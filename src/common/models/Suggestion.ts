/**
 * A row in the `suggestions` table — records the most recent action for a
 * (transaction, category) pair, used as the engine's learning history.
 *
 * Loosely coupled with the transaction: the transaction row holds the
 * denormalized "current label" (`transactions.label_*`) for hot-path reads,
 * and `suggestions` records the per-category history the engine learns
 * from. Reads of the transaction list never JOIN this table.
 *
 * UNIQUE on `(transaction_id, category_id)` — at most one row per
 * (transaction, category) pair, whose `confidence` reflects the latest
 * state of that pair:
 *
 * - `confidence = 1`: user-confirmed
 * - `0 < confidence < 1`: engine-suggested
 * - `confidence = 0`: user-rejected
 *
 * The engine UPSERTs at strict-fractional confidence and only overwrites
 * rows where the existing confidence is itself strict-fractional — it
 * never clobbers a user confirmation (1) or a user rejection (0).
 */
export interface JSONSuggestion {
  suggestion_id: string;
  transaction_id: string;
  category_id: string;
  confidence: number;
}
