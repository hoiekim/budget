import {
  JSONBudgetFamily,
  JSONCapacity,
  isNullableArray,
  isNullableBoolean,
  isNullableString,
} from "common";
import {
  CAPACITIES,
  NAME,
  ROLL_OVER,
  ROLL_OVER_START_DATE,
} from "./common";

/**
 * The four columns the budget / section / category models share — the
 * family field set (`JSONBudgetFamily` in `common/models/BudgetFamily.ts`).
 * The three model files were the same file under normalization (see #887):
 * only the parent FK (section/category) and the currency column (budget)
 * differ. These three pieces are spread into the existing explicit classes
 * — the `declare` lists stay per-model, so the classes keep reading as
 * explicit field declarations.
 *
 * `budgetFamilySchema` is spread into each `*Schema` at the position the
 * four columns already occupy, so the column order each table creates
 * with is unchanged — except `budget.ts`, where `ISO_CURRENCY_CODE`
 * moves after the family columns (it sat between `NAME` and `ROLL_OVER`).
 * Nothing consumes the column order (`*Columns` has no importers), and
 * `CREATE TABLE IF NOT EXISTS` on existing databases is a no-op, so the
 * reorder is cosmetic.
 */
export const budgetFamilySchema = {
  [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
  [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
  [ROLL_OVER_START_DATE]: "DATE",
  [CAPACITIES]: "JSONB",
};

/** The four family entries, spread into each model's `typeChecker`. */
export const budgetFamilyTypeChecker = {
  name: isNullableString,
  roll_over: isNullableBoolean,
  roll_over_start_date: isNullableString,
  capacities: isNullableArray,
};

/**
 * The family half of a `fromJSON`: copy the four family fields from the
 * JSON shape onto the row under construction. The row is a `Record` because
 * the three row types are `Partial<*Row>` mapped types over different
 * schemas — they share these four keys but no narrower common type.
 */
export const applyBudgetFamilyFields = (
  source: Partial<JSONBudgetFamily>,
  row: Record<string, unknown>,
): void => {
  if (source.name !== undefined) row.name = source.name;
  if (source.roll_over !== undefined) row.roll_over = source.roll_over;
  if (source.roll_over_start_date !== undefined)
    row.roll_over_start_date = source.roll_over_start_date;
  // Pass the array through, not a string: Bun.sql stores a string bound
  // for a JSONB column as a JSON string value, not the object (pg had the
  // server parse the string into JSON). The driver encodes objects as JSON.
  if (source.capacities !== undefined) row.capacities = source.capacities;
};

/**
 * The family half of a `toJSON`: the four fields every family model
 * returns, with `roll_over_start_date` normalized to `undefined` when the
 * row carries `null` — the shape the three `toJSON` bodies already
 * produced. Spread after the model's own id fields.
 */
export const budgetFamilyJSON = (model: {
  name: string;
  roll_over: boolean;
  roll_over_start_date: string | null;
  capacities: JSONCapacity[];
}): Pick<JSONBudgetFamily, "name" | "roll_over" | "roll_over_start_date" | "capacities"> => ({
  name: model.name,
  roll_over: model.roll_over,
  roll_over_start_date: model.roll_over_start_date || undefined,
  capacities: model.capacities,
});
