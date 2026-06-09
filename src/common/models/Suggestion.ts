/**
 * A row in the `suggestions` table — records the engine's per-(transaction,
 * category) learning history.
 *
 * Loosely coupled with the transaction: the transaction row holds the
 * denormalized "current label" (`transactions.label_*`) for hot-path reads,
 * and `suggestions` records the per-category history the engine learns
 * from. Reads of the transaction list never JOIN this table.
 *
 * Primary key is the **composite `(transaction_id, category_id)`** — at most
 * one row per pair. Lifecycle is captured by two explicit user-action flags
 * so the merchant signal never has to infer intent from numbers:
 *
 * - `is_confirmed = true` (with `confirmed_at` stamped): user accepted this
 *   category for this transaction.
 * - `is_rejected = true`: user explicitly rejected this category for this
 *   transaction.
 * - Both `false`: engine-owned row. `confidence` carries the engine's most
 *   recent score, and `engine_scored_at` stamps when the engine wrote it.
 *
 * `confidence` is the engine's score. User actions are tracked via flags so
 * we avoid the "phantom rejection" problem where `confidence = 0` could
 * mean either "engine retracted" or "user rejected".
 */
export interface JSONSuggestion {
  transaction_id: string;
  category_id: string;
  confidence: number;
  is_confirmed: boolean;
  is_rejected: boolean;
  confirmed_at: string | null;
  engine_scored_at: string | null;
}
