/**
 * A row in the `rejected_categories` table — records every (transaction,
 * category) pair the user has explicitly rejected.
 *
 * **What this table is for:** the rejection signal the suggestion engine
 * cannot derive from `transactions.label_*` alone. The legacy denorm
 * columns hold one current label per transaction, so a user who rejected
 * category A and then accepted B leaves no record of the A rejection.
 * This table fills that single gap.
 *
 * **What it deliberately does NOT store:**
 * - User confirmations — already authoritative in `transactions.label_category_id`
 *   with `label_category_confidence = 1`.
 * - Engine ephemeral scores — already in `transactions.label_category_confidence`
 *   (fractional). When the engine re-runs, it overwrites; no historical
 *   score is needed.
 *
 * Composite PRIMARY KEY `(transaction_id, category_id)` enforces "at most
 * one rejection row per pair." `ON CONFLICT DO UPDATE SET rejected_at =
 * NOW()` is the upsert idiom — a user who re-rejects the same category on
 * the same transaction just refreshes the timestamp.
 */
export interface JSONRejectedCategory {
  transaction_id: string;
  category_id: string;
  rejected_at: string | null;
}
