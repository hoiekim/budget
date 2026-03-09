import {
  isString,
  isNullableString,
  isNullableNumber,
} from "common";
import {
  USER_ID,
  USERS,
  MERCHANT_CATEGORY_CONFIDENCE,
  MERCHANT_HASH,
  CATEGORY_ID,
  CATEGORIES,
  ACCEPT_COUNT,
  REJECT_COUNT,
  LAST_REJECTED_AT,
} from "./common";
import { Model, RowValueType, createTable } from "./base";

/**
 * Tracks user-confirmed merchant → category mappings over time.
 * Used to generate auto-categorization suggestions.
 *
 * Confidence formula:
 *   base = accept_count / (accept_count + reject_count)
 *   decay = 0.5 if (now - last_rejected_at) < 30 days, else 1.0
 *   confidence = base * decay
 *
 * Suggestions are shown only when confidence > 0.95.
 */

const MERCHANT_CONFIDENCE_ID = "merchant_confidence_id";

const merchantCategoryMapSchema = {
  [MERCHANT_CONFIDENCE_ID]: "UUID DEFAULT gen_random_uuid() PRIMARY KEY",
  [MERCHANT_HASH]: "VARCHAR(64) NOT NULL",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE NOT NULL`,
  [CATEGORY_ID]: `UUID REFERENCES ${CATEGORIES}(${CATEGORY_ID}) ON DELETE CASCADE NOT NULL`,
  [ACCEPT_COUNT]: "INTEGER DEFAULT 0 NOT NULL",
  [REJECT_COUNT]: "INTEGER DEFAULT 0 NOT NULL",
  [LAST_REJECTED_AT]: "TIMESTAMPTZ",
};

type MerchantCategoryMapSchema = typeof merchantCategoryMapSchema;
type MerchantCategoryMapRow = { [k in keyof MerchantCategoryMapSchema]: RowValueType };

export interface JSONMerchantCategoryMap {
  merchant_confidence_id?: string;
  merchant_hash: string;
  user_id: string;
  category_id: string;
  accept_count: number;
  reject_count: number;
  last_rejected_at: string | null;
  /** Computed confidence score (0–1) */
  confidence?: number;
}

export class MerchantCategoryMapModel
  extends Model<JSONMerchantCategoryMap, MerchantCategoryMapSchema>
  implements MerchantCategoryMapRow
{
  declare merchant_confidence_id: string;
  declare merchant_hash: string;
  declare user_id: string;
  declare category_id: string;
  declare accept_count: number;
  declare reject_count: number;
  declare last_rejected_at: string | null;

  static typeChecker = {
    merchant_confidence_id: isString,
    merchant_hash: isString,
    user_id: isString,
    category_id: isString,
    accept_count: isNullableNumber,
    reject_count: isNullableNumber,
    last_rejected_at: isNullableString,
  };

  constructor(data: unknown) {
    super(data, MerchantCategoryMapModel.typeChecker);
  }

  /** Compute confidence score for this merchant → category mapping. */
  computeConfidence(): number {
    const total = this.accept_count + this.reject_count;
    if (total === 0) return 0;

    const base = this.accept_count / total;

    let decay = 1.0;
    if (this.last_rejected_at) {
      const daysSinceRejection =
        (Date.now() - new Date(this.last_rejected_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceRejection < 30) {
        decay = 0.5;
      }
    }

    return base * decay;
  }

  toJSON(): JSONMerchantCategoryMap {
    return {
      merchant_confidence_id: this.merchant_confidence_id,
      merchant_hash: this.merchant_hash,
      user_id: this.user_id,
      category_id: this.category_id,
      accept_count: this.accept_count,
      reject_count: this.reject_count,
      last_rejected_at: this.last_rejected_at,
      confidence: this.computeConfidence(),
    };
  }

  static fromJSON(data: Partial<JSONMerchantCategoryMap>): Partial<MerchantCategoryMapRow> {
    const r: Partial<MerchantCategoryMapRow> = {};
    if (data.merchant_confidence_id !== undefined)
      r.merchant_confidence_id = data.merchant_confidence_id;
    if (data.merchant_hash !== undefined) r.merchant_hash = data.merchant_hash;
    if (data.user_id !== undefined) r.user_id = data.user_id;
    if (data.category_id !== undefined) r.category_id = data.category_id;
    if (data.accept_count !== undefined) r.accept_count = data.accept_count;
    if (data.reject_count !== undefined) r.reject_count = data.reject_count;
    if (data.last_rejected_at !== undefined) r.last_rejected_at = data.last_rejected_at;
    return r;
  }
}

export const merchantCategoryConfidenceTable = createTable({
  name: MERCHANT_CATEGORY_CONFIDENCE,
  primaryKey: MERCHANT_CONFIDENCE_ID,
  schema: merchantCategoryMapSchema,
  constraints: [
    // Unique constraint ensures one record per (user, merchant, category) combination
    `CONSTRAINT merchant_confidence_unique UNIQUE (${MERCHANT_HASH}, ${USER_ID}, ${CATEGORY_ID})`,
  ],
  indexes: [{ column: USER_ID }, { column: MERCHANT_HASH }],
  ModelClass: MerchantCategoryMapModel,
  supportsSoftDelete: false,
});

export const merchantCategoryConfidenceColumns = Object.keys(
  merchantCategoryConfidenceTable.schema,
);
