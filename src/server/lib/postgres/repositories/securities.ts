import { JSONSecurity } from "common";
import { SecurityModel, securitiesTable, snapshotsTable, SECURITY_ID } from "../models";
import { UpsertResult, successResult, errorResult } from "../database";

export const getSecurities = async (): Promise<JSONSecurity[]> => {
  const models = await securitiesTable.query({});
  return models.map(m => m.toJSON());
};

export const getSecurity = async (security_id: string): Promise<JSONSecurity | null> => {
  const model = await securitiesTable.queryOne({ [SECURITY_ID]: security_id });
  return model?.toJSON() ?? null;
};

export const searchSecurities = async (
  options: { security_id?: string; ticker_symbol?: string; name?: string } = {}
): Promise<JSONSecurity[]> => {
  const filters: Record<string, unknown> = {};
  if (options.security_id) filters[SECURITY_ID] = options.security_id;
  if (options.ticker_symbol) filters.ticker_symbol = options.ticker_symbol;
  if (options.name) filters.name = options.name;
  
  const models = await securitiesTable.query(filters);
  return models.map(m => m.toJSON());
};

export const searchSecuritiesById = async (security_ids: string[]): Promise<JSONSecurity[]> => {
  if (!security_ids.length) return [];
  const results: JSONSecurity[] = [];
  for (const id of security_ids) {
    const sec = await getSecurity(id);
    if (sec) results.push(sec);
  }
  return results;
};

export const upsertSecurities = async (securities: JSONSecurity[]): Promise<UpsertResult[]> => {
  if (!securities.length) return [];
  const results: UpsertResult[] = [];

  for (const security of securities) {
    try {
      const row = SecurityModel.toRow(security);
      await securitiesTable.upsert(row);
      results.push(successResult(security.security_id, 1));
    } catch (error) {
      console.error(`Failed to upsert security ${security.security_id}:`, error);
      results.push(errorResult(security.security_id));
    }
  }
  return results;
};

export const deleteSecurities = async (security_ids: string[]): Promise<{ deleted: number }> => {
  if (!security_ids.length) return { deleted: 0 };

  // Securities table doesn't have is_deleted column - use hard delete
  for (const security_id of security_ids) {
    await snapshotsTable.hardDeleteByColumn(SECURITY_ID, security_id);
  }

  const deleted = await securitiesTable.bulkHardDelete(security_ids);
  return { deleted };
};
