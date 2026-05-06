import {
  Route,
  budgetsTable,
  categoriesTable,
  logger,
  pool,
  transactionsTable,
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
    const categoryIds = Array.from(
      new Set(valid.map((s) => s.label_category_id).filter((v): v is string => !!v)),
    );
    const budgetIds = Array.from(
      new Set(valid.map((s) => s.label_budget_id).filter((v): v is string => !!v)),
    );

    const [existingTxs, validCategoryIds, validBudgetIds] = await Promise.all([
      fetchTransactionsForLabelUpdate(txIds, user.user_id),
      categoryIds.length === 0
        ? new Set<string>()
        : queryIdSet(categoriesTable.name, "category_id", categoryIds, user.user_id),
      budgetIds.length === 0
        ? new Set<string>()
        : queryIdSet(budgetsTable.name, "budget_id", budgetIds, user.user_id),
    ]);

    const txByIdEntries = existingTxs.map(
      (r) => [r.transaction_id, r] as const,
    );
    const txById = new Map<
      string,
      { transaction_id: string; label_category_confidence: number | null }
    >(txByIdEntries);

    for (const s of valid) {
      const existing = txById.get(s.transaction_id);
      if (!existing) {
        outcomes.push({
          transaction_id: s.transaction_id,
          status: "skipped",
          reason: "Transaction not found or not owned by this user.",
        });
        continue;
      }
      if (existing.label_category_confidence === 1) {
        outcomes.push({
          transaction_id: s.transaction_id,
          status: "skipped",
          reason: "Refusing to overwrite user-confirmed label (confidence = 1.0).",
        });
        continue;
      }
      if (s.label_category_id && !validCategoryIds.has(s.label_category_id)) {
        outcomes.push({
          transaction_id: s.transaction_id,
          status: "error",
          reason: `Unknown label_category_id: ${s.label_category_id}`,
        });
        continue;
      }
      if (s.label_budget_id && !validBudgetIds.has(s.label_budget_id)) {
        outcomes.push({
          transaction_id: s.transaction_id,
          status: "error",
          reason: `Unknown label_budget_id: ${s.label_budget_id}`,
        });
        continue;
      }
      if (s.label_category_id === undefined && s.label_budget_id === undefined) {
        outcomes.push({
          transaction_id: s.transaction_id,
          status: "error",
          reason: "At least one of label_category_id / label_budget_id is required.",
        });
        continue;
      }

      try {
        const updates: Record<string, unknown> = {
          label_category_confidence: s.confidence,
        };
        if (s.label_category_id !== undefined) {
          updates.label_category_id = s.label_category_id;
        }
        if (s.label_budget_id !== undefined) {
          updates.label_budget_id = s.label_budget_id;
        }
        const updated = await transactionsTable.update(
          s.transaction_id,
          updates,
          undefined,
          user.user_id,
        );
        if (updated) {
          outcomes.push({ transaction_id: s.transaction_id, status: "updated" });
        } else {
          outcomes.push({
            transaction_id: s.transaction_id,
            status: "skipped",
            reason: "Update produced no row change (concurrent modification?).",
          });
        }
      } catch (error) {
        logger.error(
          "suggest-category update failed",
          { transactionId: s.transaction_id },
          error,
        );
        outcomes.push({
          transaction_id: s.transaction_id,
          status: "error",
          reason: "Internal error during update.",
        });
      }
    }

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

async function fetchTransactionsForLabelUpdate(
  ids: string[],
  user_id: string,
): Promise<{ transaction_id: string; label_category_confidence: number | null }[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `
    SELECT transaction_id, label_category_confidence
    FROM ${transactionsTable.name}
    WHERE transaction_id IN (${placeholders})
      AND user_id = $${ids.length + 1}
      AND (is_deleted IS NULL OR is_deleted = FALSE)
  `;
  const result = await pool.query(sql, [...ids, user_id]);
  return result.rows as { transaction_id: string; label_category_confidence: number | null }[];
}

async function queryIdSet(
  table: string,
  pkColumn: string,
  ids: string[],
  user_id: string,
): Promise<Set<string>> {
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `
    SELECT ${pkColumn} FROM ${table}
    WHERE ${pkColumn} IN (${placeholders})
      AND user_id = $${ids.length + 1}
      AND (is_deleted IS NULL OR is_deleted = FALSE)
  `;
  const result = await pool.query(sql, [...ids, user_id]);
  return new Set(result.rows.map((row: Record<string, unknown>) => row[pkColumn] as string));
}
