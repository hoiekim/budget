import {
  JSONRecurring,
  JSONRecurringSplit,
  RecurringStatus,
  RecurringCadence,
  isString,
  isBoolean,
  isNullableString,
  isNullableBoolean,
  isStringArray,
  isArray,
} from "common";
import {
  RECURRING_ID,
  USER_ID,
  MERCHANT_KEY,
  MERCHANT_NAME,
  CADENCE,
  IS_INCOME,
  STATUS,
  TRANSACTION_IDS,
  SPLITS,
  SPLITS_SINCE,
  LABEL_BUDGET_ID,
  LABEL_CATEGORY_ID,
  CREATED_AT,
  UPDATED,
  IS_DELETED,
} from "./common";
import { RECURRINGS, USERS } from "common/constants";

import { Model, RowValueType, createTable } from "./base";

const recurringSchema = {
  [RECURRING_ID]: "UUID PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [MERCHANT_KEY]: "TEXT NOT NULL",
  [MERCHANT_NAME]: "TEXT NOT NULL",
  [CADENCE]: "VARCHAR(20) NOT NULL",
  [IS_INCOME]: "BOOLEAN NOT NULL",
  [STATUS]: "VARCHAR(20) NOT NULL",
  [TRANSACTION_IDS]: "TEXT[] NOT NULL DEFAULT '{}'",
  [LABEL_BUDGET_ID]: "UUID",
  [LABEL_CATEGORY_ID]: "UUID",
  [SPLITS]: "JSONB NOT NULL DEFAULT '[]'",
  [SPLITS_SINCE]: "DATE",
  [CREATED_AT]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type RecurringSchema = typeof recurringSchema;
type RecurringRow = { [k in keyof RecurringSchema]: RowValueType };

export class RecurringModel
  extends Model<JSONRecurring, RecurringSchema>
  implements RecurringRow
{
  declare recurring_id: string;
  declare user_id: string;
  declare merchant_key: string;
  declare merchant_name: string;
  declare cadence: RecurringCadence;
  declare is_income: boolean;
  declare status: RecurringStatus;
  declare transaction_ids: string[];
  declare label_budget_id: string | null;
  declare label_category_id: string | null;
  declare splits: JSONRecurringSplit[];
  declare splits_since: string | null;
  declare created_at: string | null;
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    recurring_id: isString,
    user_id: isString,
    merchant_key: isString,
    merchant_name: isString,
    cadence: isString,
    is_income: isBoolean,
    status: isString,
    transaction_ids: isStringArray,
    label_budget_id: isNullableString,
    label_category_id: isNullableString,
    splits: isArray,
    splits_since: isNullableString,
    created_at: isNullableString,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, RecurringModel.typeChecker);
  }

  toJSON(): JSONRecurring {
    return {
      recurring_id: this.recurring_id,
      merchant_key: this.merchant_key,
      merchant_name: this.merchant_name,
      cadence: this.cadence,
      is_income: this.is_income,
      status: this.status,
      transaction_ids: this.transaction_ids,
      label: { budget_id: this.label_budget_id, category_id: this.label_category_id },
      splits: this.splits,
      updated: this.updated,
    };
  }
}

export const recurringsTable = createTable({
  name: RECURRINGS,
  primaryKey: RECURRING_ID,
  schema: recurringSchema,
  constraints: [
    // One recurring per (merchant, direction) per user. A merchant can be
    // both an income and an expense recurring (e.g. marketplace payouts
    // vs. purchases), but never two actives of the same direction — the
    // dismissed row is the denylist tombstone that `createRecurring`
    // un-dismisses via ON CONFLICT.
    `CONSTRAINT recurrings_user_merchant_direction_unique UNIQUE (${USER_ID}, ${MERCHANT_KEY}, ${IS_INCOME})`,
  ],
  indexes: [
    // Matches the delta-by-cursor read pattern the sync path uses:
    // `WHERE user_id = $1 AND updated >= $cursor`. Same shape every other
    // delta-fetched table carries (transactions, transaction_pairs,
    // snapshots). Without this, the planner does a user_id lookup then
    // scans + filters all of that user's recurrings.
    { columns: [USER_ID, UPDATED] },
    // Detection lookups by merchant_key per user.
    { columns: [USER_ID, MERCHANT_KEY] },
  ],
  ModelClass: RecurringModel,
});

export const recurringColumns = Object.keys(recurringsTable.schema);
