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
 * Batch institution fetch — takes a CSV `ids=<a>,<b>,<c>` and returns the
 * resolved `JSONInstitution[]`. Order of the response is not guaranteed to
 * match the request; callers index by `institution_id`. Sibling to
 * `searchAccountsById` / `searchTransactionsById` — same `queryByIds` shape.
 *
 * A `Plaid-fallback` fires for any requested id that is NOT in the DB (the
 * user just connected a new institution and its row hasn't been persisted
 * yet). Plaid's `getInstitution` is per-id, so the fallback is a small
 * `Promise.all` over the misses, not a re-batch — Plaid has no matching
 * endpoint.
 *
 * **Partial-success on Plaid miss**: a fallback failure silently omits that
 * one id from the response (200 with the other ids resolved). A fresh
 * institution the FE just connected shouldn't blank every other institution's
 * logo/name on the same render pass.
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
