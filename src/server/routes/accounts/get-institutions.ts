import { JSONInstitution } from "common";
import {
  Route,
  plaid,
  searchInstitutionsById,
  upsertInstitutions,
  requireQueryString,
  validationError,
  institutionFallbackRateLimiter,
} from "server";
import { logger } from "server/lib/logger";

export type InstitutionsGetResponse = JSONInstitution[];

// The request's downstream cost is linear in the id list, and the caller
// chooses its length.
const MAX_REQUESTED_IDS = 100;

/**
 * Batch institution fetch — takes a CSV `ids=<a>,<b>,<c>` and returns the
 * resolved `JSONInstitution[]`. Order of the response is not guaranteed to
 * match the request; callers index by `institution_id`. Sibling to
 * `searchAccountsById` / `searchTransactionsById` — same `queryByIds` shape.
 *
 * A `Plaid-fallback` fires for any requested id that is NOT in the DB. Plaid
 * has no batch endpoint for institutions, so the fallback is a fan-out over the
 * misses; `institutions` is a global table with no owner column, so any string
 * the caller invents reaches it. Bounded on three axes: ids per request, Plaid
 * round trips per user per minute, and round trips in flight process-wide.
 *
 * A fallback failure omits that one id rather than failing the response — one
 * unresolvable institution shouldn't blank every other institution's logo and
 * name on the same render pass.
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

    const parsed = idsResult
      .data!.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "Unknown");
    if (parsed.length > MAX_REQUESTED_IDS) {
      return validationError(
        `Parameter ids accepts at most ${MAX_REQUESTED_IDS} institution ids per request`,
      );
    }

    // Before the miss set, not only inside the repo: a repeated unresolvable id
    // costs one Plaid round trip per copy otherwise.
    const requested = Array.from(new Set(parsed));
    if (requested.length === 0) return { status: "success", body: [] };

    const stored = await searchInstitutionsById(requested);
    const storedIds = new Set(stored.map((i) => i.institution_id));
    const missing = requested.filter((id) => !storedIds.has(id));

    if (missing.length === 0) {
      return { status: "success", body: stored };
    }

    const budget = institutionFallbackRateLimiter.remaining(user.user_id);
    const fetchable = missing.slice(0, budget);
    if (fetchable.length < missing.length) {
      logger.warn("Institution Plaid-fallback capped by the per-user rate limit", {
        userId: user.user_id,
        missing: missing.length,
        allowed: fetchable.length,
      });
    }
    if (fetchable.length === 0) {
      // Shedding the whole request would blank every institution the user does
      // have, over a cap it did nothing to earn.
      return { status: "success", body: stored };
    }

    institutionFallbackRateLimiter.consume(user.user_id, fetchable.length);
    const fetched = await plaid.getInstitutionsByIds(user, fetchable);

    if (fetched.length > 0) {
      // Off the latency path: only the next request's DB hit depends on the
      // row landing.
      upsertInstitutions(fetched).catch((error) =>
        logger.error("Failed to upsert institutions", { count: fetched.length }, error),
      );
    }

    return { status: "success", body: [...stored, ...fetched] };
  },
);
