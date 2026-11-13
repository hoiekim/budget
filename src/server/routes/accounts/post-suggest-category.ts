import {
  Route,
  budgetsTable,
  categoriesTable,
  isUuid,
  logger,
  transactionsTable,
  USER_ID,
} from "server";
import { isString, isNullableString, isNumber } from "common";

export type SuggestCategoryRowOutcome =
  | { transaction_id: string; status: "updated" }
  | { transaction_id: string; status: "skipped"; reason: string }
  | { transaction_id: string; status: "error"; reason: string };

export interface SuggestCategoryResponse {
  outcomes: SuggestCategoryRowOutcome[];
  updated: number;
  skipped: number;
  errored: number;
}

interface SuggestionInput {
  transaction_id: string;
  label_category_id?: string | null;
  label_budget_id?: string | null;
  confidence: number;
}

const isSuggestion = (v: unknown): v is SuggestionInput => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isString(o.transaction_id)) return false;
  if (!isNumber(o.confidence)) return false;
  // confidence must be in (0, 1) — we reject 1.0 to keep "user-confirmed"
  // (1.0) reserved for the cookie-session UI write path. Negative or > 1
  // is nonsense.
  if (!(o.confidence > 0 && o.confidence < 1)) return false;
  if (o.label_category_id !== undefined && !isNullableString(o.label_category_id)) return false;
  if (o.label_budget_id !== undefined && !isNullableString(o.label_budget_id)) return false;
  return true;
};

// Max concurrent UPDATEs while applying a batch. The pg pool caps at 20
// connections, and a 500-row batch used to pay one sequential round-trip
// per suggestion; 10 in flight leaves headroom for the rest of the request
// and for concurrent requests.
const SUGGEST_UPDATE_CONCURRENCY = 10;

export const postSuggestCategoryRoute = new Route<SuggestCategoryResponse>(
  "POST",
  "/suggest-category",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const body = req.body as { suggestions?: unknown } | null | undefined;
    if (!body || !Array.isArray(body.suggestions)) {
      return {
        status: "failed",
        message: "Body must be { suggestions: [{ transaction_id, confidence, ... }] }",
      };
    }
    if (body.suggestions.length === 0) {
      return { status: "success", body: { outcomes: [], updated: 0, skipped: 0, errored: 0 } };
    }
    if (body.suggestions.length > 500) {
      return {
        status: "failed",
        message: "suggestions array must contain at most 500 entries per request",
      };
    }

    const valid: SuggestionInput[] = [];
    const outcomes: SuggestCategoryRowOutcome[] = [];

    for (const raw of body.suggestions) {
      if (!isSuggestion(raw)) {
        outcomes.push({
          transaction_id:
            (raw as { transaction_id?: unknown })?.transaction_id?.toString?.() ?? "<invalid>",
          status: "error",
          reason:
            "Invalid shape. Required: { transaction_id: string, confidence: number in (0,1) exclusive }, with optional label_category_id and label_budget_id.",
        });
        continue;
      }
      valid.push(raw);
    }

    if (valid.length === 0) {
      return {
        status: "success",
        body: summarize(outcomes),
      };
    }

    // Pre-fetch the relevant rows in batch:
    //  - transactions (must exist + belong to the user + confidence < 1.0)
    //  - candidate categories and budgets (must belong to the user)
    const txIds = Array.from(new Set(valid.map((s) => s.transaction_id)));
    // Only well-formed UUIDs reach the pre-fetch: category_id / budget_id
    // are UUID PRIMARY KEY columns, and Postgres raises 22P02 on a
    // non-UUID bound against them — which would 500 the whole batch
    // before the per-row "Unknown label_*" branch below can report it.
    // A malformed id is filtered out here so it lands on that branch
    // instead (#789).
    const categoryIds = Array.from(
      new Set(
        valid
          .map((s) => s.label_category_id)
          .filter((v): v is string => isUuid(v)),
      ),
    );
    const budgetIds = Array.from(
      new Set(
        valid
          .map((s) => s.label_budget_id)
          .filter((v): v is string => isUuid(v)),
      ),
    );

    // Pre-fetch through the repository layer, which applies the canonical
    // soft-delete predicate and the user scoping — the route no longer
    // hand-writes SQL for these reads.
    const [existingTxs, categoryRows, budgetRows] = await Promise.all([
      transactionsTable.queryByIds(txIds, { [USER_ID]: user.user_id }),
      categoryIds.length === 0
        ? []
        : categoriesTable.queryByIds(categoryIds, { [USER_ID]: user.user_id }),
      budgetIds.length === 0
        ? []
        : budgetsTable.queryByIds(budgetIds, { [USER_ID]: user.user_id }),
    ]);
    const validCategoryIds = new Set(categoryRows.map((r) => r.category_id));
    const validBudgetIds = new Set(budgetRows.map((r) => r.budget_id));

    const txById = new Map(existingTxs.map((r) => [r.transaction_id, r] as const));

    // Validate every suggestion against the pre-fetched rows first, then
    // apply the surviving updates in bounded-concurrency chunks instead of
    // one sequential round-trip per suggestion. Outcomes stay aligned with
    // the input order: each slot is filled either by validation or by its
    // update's result.
    const results: SuggestCategoryRowOutcome[] = new Array(valid.length);
    const pending: {
      index: number;
      suggestion: SuggestionInput;
      updates: Record<string, unknown>;
    }[] = [];
    for (let i = 0; i < valid.length; i++) {
      const s = valid[i]!;
      const existing = txById.get(s.transaction_id);
      if (!existing) {
        results[i] = {
          transaction_id: s.transaction_id,
          status: "skipped",
          reason: "Transaction not found or not owned by this user.",
        };
        continue;
      }
      if (existing.label_category_confidence === 1) {
        results[i] = {
          transaction_id: s.transaction_id,
          status: "skipped",
          reason: "Refusing to overwrite user-confirmed label (confidence = 1.0).",
        };
        continue;
      }
      if (s.label_category_id && !validCategoryIds.has(s.label_category_id)) {
        results[i] = {
          transaction_id: s.transaction_id,
          status: "error",
          reason: `Unknown label_category_id: ${s.label_category_id}`,
        };
        continue;
      }
      if (s.label_budget_id && !validBudgetIds.has(s.label_budget_id)) {
        results[i] = {
          transaction_id: s.transaction_id,
          status: "error",
          reason: `Unknown label_budget_id: ${s.label_budget_id}`,
        };
        continue;
      }
      if (s.label_category_id === undefined && s.label_budget_id === undefined) {
        results[i] = {
          transaction_id: s.transaction_id,
          status: "error",
          reason: "At least one of label_category_id / label_budget_id is required.",
        };
        continue;
      }
      const updates: Record<string, unknown> = {
        label_category_confidence: s.confidence,
      };
      if (s.label_category_id !== undefined) {
        updates.label_category_id = s.label_category_id;
      }
      if (s.label_budget_id !== undefined) {
        updates.label_budget_id = s.label_budget_id;
      }
      pending.push({ index: i, suggestion: s, updates });
    }

    for (let start = 0; start < pending.length; start += SUGGEST_UPDATE_CONCURRENCY) {
      const chunk = pending.slice(start, start + SUGGEST_UPDATE_CONCURRENCY);
      const chunkOutcomes = await Promise.all(
        chunk.map(
          async ({
            index,
            suggestion: s,
            updates,
          }): Promise<{ index: number; outcome: SuggestCategoryRowOutcome }> => {
            try {
              const updated = await transactionsTable.update(
                s.transaction_id,
                updates,
                undefined,
                user.user_id,
              );
              return {
                index,
                outcome: updated
                  ? { transaction_id: s.transaction_id, status: "updated" }
                  : {
                      transaction_id: s.transaction_id,
                      status: "skipped",
                      reason: "Update produced no row change (concurrent modification?).",
                    },
              };
            } catch (error) {
              logger.error(
                "suggest-category update failed",
                { transactionId: s.transaction_id },
                error,
              );
              return {
                index,
                outcome: {
                  transaction_id: s.transaction_id,
                  status: "error",
                  reason: "Internal error during update.",
                },
              };
            }
          },
        ),
      );
      for (const { index, outcome } of chunkOutcomes) {
        results[index] = outcome;
      }
    }

    outcomes.push(...results);

    return { status: "success", body: summarize(outcomes) };
  },
  { requiredScope: "transactions:suggest" },
);

function summarize(outcomes: SuggestCategoryRowOutcome[]): SuggestCategoryResponse {
  let updated = 0,
    skipped = 0,
    errored = 0;
  for (const o of outcomes) {
    if (o.status === "updated") updated++;
    else if (o.status === "skipped") skipped++;
    else errored++;
  }
  return { outcomes, updated, skipped, errored };
}
