import type { JSONTransactionLabel } from "common";

interface MaybeLabeled {
  label?: Partial<JSONTransactionLabel>;
}

/**
 * Route-layer helper that lifts user intent from a label update into the
 * `category_confidence` column when the caller didn't set it explicitly.
 *
 * Mapping:
 *  - caller omits `category_id` entirely → don't touch confidence (no-op call)
 *  - `category_id: <string>` + confidence undefined → confidence = 1
 *    (user explicitly chose a category — treat as confirmed)
 *  - `category_id: null`    + confidence undefined → confidence = 0
 *    (user cleared the category — treat as a rejection signal so the
 *    auto-suggest engine doesn't immediately re-suggest the same thing)
 *  - caller sets confidence explicitly → preserve (e.g. Accept-All sends 1
 *    when the row already has a category_id; the API caller path on the
 *    `/suggest-category` route sends fractional values; tests may set 0
 *    directly)
 *
 * Owned by the route boundary, not the repo: the repo just persists
 * what it's given; route handlers call this helper before passing the
 * body downstream so the "user intent" mapping happens next to HTTP
 * request parsing, not inside the persistence layer.
 */
export const inferLabelConfidence = <T extends MaybeLabeled>(input: T): T => {
  if (!input.label) return input;
  if (!("category_id" in input.label)) return input;
  if (input.label.category_confidence !== undefined) return input;
  const category_confidence = input.label.category_id === null ? 0 : 1;
  return { ...input, label: { ...input.label, category_confidence } };
};
