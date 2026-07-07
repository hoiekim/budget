import { JSONSecurity } from "common";
import {
  MaskedUser,
  SecurityModel,
  securitiesTable,
  snapshotsTable,
  SECURITY_ID,
  SECURITIES,
  HOLDINGS,
  USER_ID,
} from "../models";
import { pool, withTransaction } from "../client";
import { UpsertResult, successResult, errorResult } from "../database";
import { logger } from "../../logger";

export const getSecurities = async (): Promise<JSONSecurity[]> => {
  const models = await securitiesTable.query({});
  return models.map((m) => m.toJSON());
};

/**
 * Securities the given user has any holding for (active or soft-deleted).
 * Used by `GET /api/securities` so the response is scoped to the caller's
 * portfolio rather than leaking every ticker the DB has ever seen.
 *
 * INNER JOIN against `holdings` for the user_id filter; `DISTINCT` because
 * a single security can back multiple holdings (different accounts /
 * historical rows). Soft-deleted holdings are intentionally included so a
 * recent unlink doesn't drop the security from the FE dict mid-session.
 */
export const getSecuritiesForUser = async (user: MaskedUser): Promise<JSONSecurity[]> => {
  // INNER JOIN against `holdings` + DISTINCT — outside Table.query's surface.
  const sql = `
    SELECT DISTINCT s.*
    FROM ${SECURITIES} s
    INNER JOIN ${HOLDINGS} h ON h.${SECURITY_ID} = s.${SECURITY_ID}
    WHERE h.${USER_ID} = $1
  `;
  const result = await pool.query<Record<string, unknown>>(sql, [user.user_id]);
  return result.rows.map((row) => new SecurityModel(row).toJSON());
};

export const getSecurity = async (security_id: string): Promise<JSONSecurity | null> => {
  const model = await securitiesTable.queryOne({ [SECURITY_ID]: security_id });
  return model?.toJSON() ?? null;
};

export const searchSecurities = async (
  options: { security_id?: string; ticker_symbol?: string; name?: string } = {},
): Promise<JSONSecurity[]> => {
  const filters: Record<string, unknown> = {};
  if (options.security_id) filters[SECURITY_ID] = options.security_id;
  if (options.ticker_symbol) filters.ticker_symbol = options.ticker_symbol;
  if (options.name) filters.name = options.name;

  const models = await securitiesTable.query(filters);
  return models.map((m) => m.toJSON());
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
      const row = SecurityModel.fromJSON(security);
      await securitiesTable.upsert(row);
      results.push(successResult(security.security_id, 1));
    } catch (error) {
      logger.error("Failed to upsert security", { securityId: security.security_id }, error);
      results.push(errorResult(security.security_id));
    }
  }
  return results;
};

/**
 * Repoint every DB reference to `oldSecurityId` at `newSecurityId`, then
 * hard-delete the old `securities` row. Runs in a single transaction so a
 * mid-remap failure can't leave orphaned references. Global across users —
 * `securities` is a shared table, no user_id column, and a ticker
 * collision on a shared row transitively touches every user that already
 * referenced it (mirrors the current cross-user behavior of the pre-fix
 * "canonical wins" flow).
 *
 * Callers: `upsertSecuritiesWithSnapshots` when incoming (Plaid/SimpleFin)
 * `security_id` differs from an existing row with the same ticker. The
 * incoming ID becomes canonical.
 */
export const remapSecurityReferences = async (
  oldSecurityId: string,
  newSecurityId: string,
): Promise<void> => {
  if (oldSecurityId === newSecurityId) return;
  // Every UPDATE bumps `updated = CURRENT_TIMESTAMP` so the FE's
  // delta-cursor sync (`.../{transactions,snapshots}?start-date=<cursor>`
  // → `WHERE updated >= cursor`) actually picks up the remapped rows.
  // Without it, investment_transactions + holding-snapshot rows would
  // keep pointing at the deleted `oldSecurityId` in the FE cache and
  // in IndexedDB, and downstream `securities.get(security_id)` lookups
  // would miss until the user forced a full re-sync. `securities`,
  // `accounts`+holdings, `budgets` etc. are full-fetched every sync so
  // the securities row's disappearance propagates without extra help.
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE investment_transactions SET security_id = $1, updated = CURRENT_TIMESTAMP WHERE security_id = $2",
      [newSecurityId, oldSecurityId],
    );
    await client.query(
      "UPDATE holdings SET security_id = $1, updated = CURRENT_TIMESTAMP WHERE security_id = $2",
      [newSecurityId, oldSecurityId],
    );
    await client.query(
      "UPDATE snapshots SET security_id = $1, updated = CURRENT_TIMESTAMP WHERE security_id = $2",
      [newSecurityId, oldSecurityId],
    );
    await client.query(
      "UPDATE snapshots SET holding_security_id = $1, updated = CURRENT_TIMESTAMP WHERE holding_security_id = $2",
      [newSecurityId, oldSecurityId],
    );
    await client.query("DELETE FROM securities WHERE security_id = $1", [oldSecurityId]);
  });
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
