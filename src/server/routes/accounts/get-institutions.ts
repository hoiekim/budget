import { JSONInstitution } from "common";
import {
  Route,
  plaid,
  searchInstitutionsById,
  upsertInstitutions,
  requireQueryString,
  validationError,
} from "server";
import { logger } from "server/lib/logger";

export type InstitutionsGetResponse = JSONInstitution[];

/**
 * Batch companion to `GET /institution?id=<one>` — takes a CSV `ids=<a>,<b>`
 * and returns the resolved `JSONInstitution[]`. Order of the response is not
 * guaranteed to match the request; callers index by `institution_id`.
 *
 * Before this route the FE issued one `GET /institution?id=` per account per
 * sync — the PR #674 profiling measured 14 sequential GETs (with duplicates
 * `ins_5 ×3`, `ins_56 ×3`) as ~3 KB of payload but 14 RTTs of latency and log
 * noise. This route serves the same payload in one query. Sibling to
 * `searchAccountsById` / `searchTransactionsById` — same `queryByIds` shape.
 *
 * A `Plaid-fallback` fires for any requested id that is NOT in the DB (the
 * user just connected a new institution and its row hasn't been persisted
 * yet — same fallback `GET /institution?id=` already implements). Plaid's
 * `getInstitution` is per-id, so the fallback is a small `Promise.all` over
 * the misses, not a re-batch — Plaid has no matching endpoint.
 */
export const getInstitutionsRoute = new Route<InstitutionsGetResponse>(
  "GET",
  "/institutions",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const idsResult = requireQueryString(req, "ids");
    if (!idsResult.success) return validationError(idsResult.error!);

    const requested = idsResult
      .data!.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "Unknown");
    if (requested.length === 0) return { status: "success", body: [] };

    const stored = await searchInstitutionsById(requested);
    const storedIds = new Set(stored.map((i) => i.institution_id));
    const missing = requested.filter((id) => !storedIds.has(id));

    if (missing.length === 0) {
      return { status: "success", body: stored };
    }

    // Plaid-fallback for the misses. Plaid's endpoint is per-institution, so
    // this loop still costs O(misses) Plaid RTTs — but misses are rare (a
    // fresh connection at most) and cannot use an IN query anyway. Upsert
    // each fetched row so the next sync's DB hit finds it.
    const fetched = await Promise.all(
      missing.map(async (id) => {
        try {
          const inst = await plaid.getInstitution(user, id);
          if (!inst) return null;
          upsertInstitutions([inst]).catch((error) =>
            logger.error("Failed to upsert institution", { institutionId: id }, error),
          );
          return inst;
        } catch (error) {
          logger.error("Failed to fetch institution from Plaid", { institutionId: id }, error);
          return null;
        }
      }),
    );

    const resolved = fetched.filter((i): i is JSONInstitution => i !== null);
    return { status: "success", body: [...stored, ...resolved] };
  },
);
