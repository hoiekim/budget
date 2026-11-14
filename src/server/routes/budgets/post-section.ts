import { SECTION_NAME_REQUIRED_MESSAGE } from "common";
import { makeUpdateEntityRoute, updateSection } from "server";
import type { FieldSpec } from "server";

/**
 * Typed fields `updateSection` writes (`models/section.ts`).
 * `name` is not nullable here even though the column is: the client's
 * `BudgetFamily.name` is a plain `string`, so a null name renders as a
 * blank row wherever the name is shown.
 */
const SECTION_BODY_SPEC: FieldSpec[] = [
  { path: "section_id", type: "uuid" },
  { path: "name", type: "string" },
  { path: "roll_over", type: "boolean", nullable: true },
  { path: "roll_over_start_date", type: "date", nullable: true },
  { path: "capacities", type: "array" },
];

export const postSectionRoute = makeUpdateEntityRoute("/section", updateSection, {
  idField: "section_id",
  fieldSpec: SECTION_BODY_SPEC,
  entityLabel: "section",
  idLogKey: "sectionId",
  // The empty-name guard is per-entity — each entity answers with its own
  // message — so it stays an extra rather than a shared rule.
  extraChecks: (data) => {
    if (typeof data.name === "string" && data.name.trim() === "") {
      return { status: "failed", message: SECTION_NAME_REQUIRED_MESSAGE };
    }
    return null;
  },
});
