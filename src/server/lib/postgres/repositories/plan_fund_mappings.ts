import { createHash } from "crypto";
import {
  MaskedUser,
  JSONPlanFundMapping,
  planFundMappingsTable,
  ACCOUNT_ID,
  USER_ID,
  SECURITY_ID,
  RESTATED,
  IS_DELETED,
  QueryExecutor,
} from "../models";

export type PlanFundMappingInput = Pick<JSONPlanFundMapping, "investment" | "security_id" | "restated">;

/** One mapping per (account, statement fund name), so saving a fund again replaces it. */
export const getPlanFundMappingId = (account_id: string, investment: string): string =>
  `pfm-${createHash("sha256").update(`${account_id}\0${investment}`).digest("hex").slice(0, 32)}`;

export const getPlanFundMappings = async (
  user: MaskedUser,
  account_id: string,
): Promise<JSONPlanFundMapping[]> => {
  const models = await planFundMappingsTable.query({
    [USER_ID]: user.user_id,
    [ACCOUNT_ID]: account_id,
  });
  return models.map((m) => m.toJSON());
};

/**
 * `user_id` and `account_id` are left out of the conflict update: the id is
 * derived from the account, which the caller has already checked belongs to
 * this user.
 */
const MAPPING_UPDATE_COLUMNS = [SECURITY_ID, RESTATED, IS_DELETED];

export const savePlanFundMappings = async (
  user: MaskedUser,
  account_id: string,
  mappings: PlanFundMappingInput[],
  client?: QueryExecutor,
): Promise<void> => {
  if (!mappings.length) return;
  const rows = mappings.map((m) => ({
    plan_fund_mapping_id: getPlanFundMappingId(account_id, m.investment),
    user_id: user.user_id,
    account_id,
    investment: m.investment,
    security_id: m.security_id,
    restated: m.restated,
    is_deleted: false,
  }));
  await planFundMappingsTable.upsertMany(rows, MAPPING_UPDATE_COLUMNS, client);
};
