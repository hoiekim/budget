import { CATEGORY_NAME_REQUIRED_MESSAGE } from "common";
import { makeUpdateEntityRoute, updateCategory } from "server";
import type { FieldSpec } from "server";

/**
 * Typed fields `updateCategory` writes (`models/category.ts`).
 * `name` is not nullable here even though the column is: the client's
 * `BudgetFamily.name` is a plain `string`, so a null name renders as a
 * blank selectable option wherever the name is shown.
 */
const CATEGORY_BODY_SPEC: FieldSpec[] = [
  { path: "category_id", type: "uuid" },
  { path: "name", type: "string", maxLength: 255 },
  { path: "roll_over", type: "boolean", nullable: true },
  { path: "roll_over_start_date", type: "date", nullable: true },
  { path: "capacities", type: "array" },
];

export const postCategoryRoute = makeUpdateEntityRoute("/category", updateCategory, {
  idField: "category_id",
  fieldSpec: CATEGORY_BODY_SPEC,
  entityLabel: "category",
  idLogKey: "categoryId",
  // The empty-name guard is per-entity — each entity answers with its own
  // message — so it stays an extra rather than a shared rule.
  extraChecks: (data) => {
    if (typeof data.name === "string" && data.name.trim() === "") {
      return { status: "failed", message: CATEGORY_NAME_REQUIRED_MESSAGE };
    }
    return null;
  },
});
