import { JSONInstitution } from "common";
import { InstitutionModel, institutionsTable, INSTITUTION_ID } from "../models";
import { UpsertResult, successResult, errorResult } from "../database";

export const getInstitutions = async (): Promise<JSONInstitution[]> => {
  const models = await institutionsTable.query({});
  return models.map((m) => m.toJSON());
};

export const getInstitution = async (institution_id: string): Promise<JSONInstitution | null> => {
  const model = await institutionsTable.queryOne({ [INSTITUTION_ID]: institution_id });
  return model?.toJSON() ?? null;
};

export const searchInstitutions = async (
  options: { institution_id?: string; name?: string } = {},
): Promise<JSONInstitution[]> => {
  const filters: Record<string, unknown> = {};
  if (options.institution_id) filters[INSTITUTION_ID] = options.institution_id;
  if (options.name) filters.name = options.name;

  const models = await institutionsTable.query(filters);
  return models.map((m) => m.toJSON());
};

export const upsertInstitutions = async (
  institutions: JSONInstitution[],
): Promise<UpsertResult[]> => {
  if (!institutions.length) return [];
  const results: UpsertResult[] = [];

  for (const institution of institutions) {
    try {
      const row = InstitutionModel.fromJSON(institution);
      await institutionsTable.upsert(row);
      results.push(successResult(institution.institution_id, 1));
    } catch (error) {
      console.error(`Failed to upsert institution ${institution.institution_id}:`, error);
      results.push(errorResult(institution.institution_id));
    }
  }
  return results;
};

export const searchInstitutionsById = async (
  institution_ids: string[],
): Promise<JSONInstitution[]> => {
  if (!institution_ids.length) return [];
  const results: JSONInstitution[] = [];
  for (const id of institution_ids) {
    const inst = await getInstitution(id);
    if (inst) results.push(inst);
  }
  return results;
};
