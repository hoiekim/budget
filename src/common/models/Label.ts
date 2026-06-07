/**
 * A row in the `labels` table — represents a single user- or engine-issued
 * label on a transaction or account.
 *
 * Multiple rows can exist for the same `parent_id` at different `confidence`
 * values: the engine writes its suggestion at `0 < confidence < 1`, the user
 * writes their confirmed choice at `confidence = 1`, and the user writes
 * rejected categories at `confidence = 0` (with `category_id` set to the
 * rejected category so the merchant signal can learn from the reject).
 *
 * UNIQUE on `(parent_id, confidence)` — at most one label per parent per
 * confidence value. When a user takes an action (confirm/reject/change),
 * engine-suggestion rows for that parent are removed so the
 * `MAX(confidence)`-per-parent read resolves to the user's intent rather
 * than the stale engine suggestion.
 */
export interface JSONLabel {
  label_id: string;
  parent_type: "transaction" | "account";
  parent_id: string;
  memo: string | null;
  budget_id: string | null;
  category_id: string | null;
  confidence: number;
}
