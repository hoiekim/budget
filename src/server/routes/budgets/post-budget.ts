import { BUDGET_NAME_REQUIRED_MESSAGE } from "common";
import { makeUpdateEntityRoute, updateBudget } from "server";
import type { FieldSpec } from "server";

/**
 * Typed fields `BudgetModel.fromJSON` copies into a row (`models/budget.ts`).
 * `name` is not nullable here even though the column is: the client's
 * `BudgetFamily.name` is a plain `string` and `useBudgetCategorySelect` calls
 * `.trim()` on it unguarded, so a null name renders every transaction row into
 * a TypeError.
 */
const BUDGET_BODY_SPEC: FieldSpec[] = [
  { path: "budget_id", type: "uuid" },
  { path: "name", type: "string" },
  { path: "iso_currency_code", type: "string", nullable: true },
  { path: "roll_over", type: "boolean", nullable: true },
  { path: "roll_over_start_date", type: "date", nullable: true },
  { path: "capacities", type: "array" },
];

export const postBudgetRoute = makeUpdateEntityRoute("/budget", updateBudget, {
  idField: "budget_id",
  fieldSpec: BUDGET_BODY_SPEC,
  entityLabel: "budget",
  idLogKey: "budgetId",
  // The empty-name guard is per-entity — each entity answers with its own
  // message — so it stays an extra rather than a shared rule.
  extraChecks: (data) => {
    if (typeof data.name === "string" && data.name.trim() === "") {
      return { status: "failed", message: BUDGET_NAME_REQUIRED_MESSAGE };
    }
    return null;
  },
});
