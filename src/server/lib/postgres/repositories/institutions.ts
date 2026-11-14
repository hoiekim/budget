import { JSONInstitution } from "common";
import { InstitutionModel, institutionsTable, INSTITUTION_ID, QueryExecutor } from "../models";
import { UpsertResult, successResult, errorResult } from "../database";
import { logger } from "../../logger";

export const upsertInstitutions = async (
  institutions: JSONInstitution[],
  client?: QueryExecutor,
): Promise<UpsertResult[]> => {
  if (!institutions.length) return [];

  const rows = institutions.map((institution) => InstitutionModel.fromJSON(institution));

  try {
    const upserted = await institutionsTable.upsertMany(rows, undefined, client);
    const written = new Set(upserted.map((row) => row[INSTITUTION_ID]));
    return institutions.map((institution) =>
      successResult(institution.institution_id, written.has(institution.institution_id) ? 1 : 0),
    );
  } catch (error) {
    const institutionIds = institutions.map((institution) => institution.institution_id);
    logger.error("Failed to upsert institutions", { institutionIds }, error);
    return institutions.map((institution) => errorResult(institution.institution_id));
  }
};

/**
 * Batch lookup: one `IN`-based query for every id at once, not per-id.
 * Missing ids are simply absent from the result — callers that need
 * Plaid-fallback for unknown institution_ids handle it at the route
 * layer (`GET /institutions?ids=...` does).
 */
export const searchInstitutionsById = async (
  institution_ids: string[],
): Promise<JSONInstitution[]> => {
  if (!institution_ids.length) return [];
  // Dedupe defensively — the client dedupes, but the repo shouldn't
  // trust that.
  const unique = Array.from(new Set(institution_ids));
  const models = await institutionsTable.queryByIds(unique);
  return models.map((m) => m.toJSON());
};
