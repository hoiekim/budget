import { isString, isNullableString, isNullableBoolean } from "common";
import {
  PLAN_FUND_MAPPING_ID,
  USER_ID,
  ACCOUNT_ID,
  INVESTMENT,
  SECURITY_ID,
  RESTATED,
  UPDATED,
  IS_DELETED,
} from "./common";
import { PLAN_FUND_MAPPINGS, USERS } from "common/constants";

import { Model, RowValueType, createTable } from "./base";

export interface JSONPlanFundMapping {
  plan_fund_mapping_id: string;
  account_id: string;
  /** The fund name exactly as the plan statement's `Investment` column spells it. */
  investment: string;
  security_id: string;
  /**
   * The plan holds a collective-trust version of this security's public fund,
   * so its rows are written as the public fund's shares rather than the trust's
   * units.
   */
  restated: boolean;
}

const planFundMappingSchema = {
  [PLAN_FUND_MAPPING_ID]: "VARCHAR(255) PRIMARY KEY",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [ACCOUNT_ID]: "VARCHAR(255) NOT NULL",
  [INVESTMENT]: "TEXT NOT NULL",
  [SECURITY_ID]: "VARCHAR(255) NOT NULL",
  [RESTATED]: "BOOLEAN NOT NULL DEFAULT FALSE",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type PlanFundMappingSchema = typeof planFundMappingSchema;
type PlanFundMappingRow = { [k in keyof PlanFundMappingSchema]: RowValueType };

export class PlanFundMappingModel
  extends Model<JSONPlanFundMapping, PlanFundMappingSchema>
  implements PlanFundMappingRow
{
  declare plan_fund_mapping_id: string;
  declare user_id: string;
  declare account_id: string;
  declare investment: string;
  declare security_id: string;
  declare restated: boolean;
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    plan_fund_mapping_id: isString,
    user_id: isString,
    account_id: isString,
    investment: isString,
    security_id: isString,
    restated: isNullableBoolean,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, PlanFundMappingModel.typeChecker);
  }

  toJSON(): JSONPlanFundMapping {
    return {
      plan_fund_mapping_id: this.plan_fund_mapping_id,
      account_id: this.account_id,
      investment: this.investment,
      security_id: this.security_id,
      restated: this.restated ?? false,
    };
  }
}

export const planFundMappingsTable = createTable({
  name: PLAN_FUND_MAPPINGS,
  primaryKey: PLAN_FUND_MAPPING_ID,
  schema: planFundMappingSchema,
  indexes: [{ columns: [USER_ID, ACCOUNT_ID] }],
  ModelClass: PlanFundMappingModel,
});
