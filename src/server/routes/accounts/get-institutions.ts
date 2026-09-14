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

/**
 * Upper bound on how many ids one request may carry. The client sends one id
 * per institution the user has connected, so this sits far above any real
 * request; what it stops is a caller sizing the id list itself, since the
 * request's cost downstream is linear in that list.
 */
const MAX_REQUESTED_IDS = 100;

/**
 * Batch institution fetch — takes a CSV `ids=<a>,<b>,<c>` and returns the
 * resolved `JSONInstitution[]`. Order of the response is not guaranteed to
 * match the request; callers index by `institution_id`. Sibling to
 * `searchAccountsById` / `searchTransactionsById` — same `queryByIds` shape.
 *
 * A `Plaid-fallback` fires for any requested id that is NOT in the DB (the
 * user just connected a new institution and its row hasn't been persisted
 * yet). Plaid's `getInstitution` is per-id, so the fallback is a fan-out over
 * the misses, not a re-batch — Plaid has no matching endpoint.
 *
 * `institutions` is a global table with no owner column, so whether an id is a
 * miss depends only on the id, never on the caller. That makes the fallback
 * reachable by any string the caller invents, and it is bounded on three axes:
 * ids per request, Plaid round trips per user per minute, and round trips in
 * flight process-wide.
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

    const parsed = idsResult
      .data!.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "Unknown");
    if (parsed.length > MAX_REQUESTED_IDS) {
      return validationError(
        `Parameter ids accepts at most ${MAX_REQUESTED_IDS} institution ids per request`,
      );
    }

    // Dedupe before the miss set is built, not only inside the repo: a
    // repeated unresolvable id would otherwise cost one Plaid round trip per
    // copy of it.
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
        missing: missing.length,
        allowed: fetchable.length,
      });
    }
    if (fetchable.length === 0) {
      // Shedding the whole request would blank every institution the user does
      // have, so the cap degrades to the stored rows the same way a Plaid
      // failure does.
      return { status: "success", body: stored };
    }

    institutionFallbackRateLimiter.consume(user.user_id, fetchable.length);
    const fetched = await plaid.getInstitutionsByIds(user, fetchable);

    if (fetched.length > 0) {
      // Off the latency path: the response doesn't depend on the row landing,
      // only the next request's DB hit does.
      upsertInstitutions(fetched).catch((error) =>
        logger.error("Failed to upsert institutions", { count: fetched.length }, error),
      );
    }

    return { status: "success", body: [...stored, ...fetched] };
  },
);
