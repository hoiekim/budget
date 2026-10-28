import {
  Route,
  rejectTransferPair,
  requireQueryString,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec } from "server";

/**
 * `id` names the `transaction_pairs.pair_id` `UUID PRIMARY KEY` column:
 * a non-UUID value handed to `WHERE pair_id = $1` raises Postgres `22P02`
 * invalid input syntax for type uuid at the read, throwing out of the
 * route — a 500 plus an alarm for a request the route could have refused
 * with the standard validation-error body instead. This is the sibling
 * of the `POST /transfers/pair` boundary the same class of defect
 * (#808) hit there: `requireQueryString` guarantees only a non-empty
 * string, not a UUID, so the shape check has to happen here.
 */
const REJECT_TRANSFER_QUERY_SPEC: FieldSpec[] = [
  { path: "id", type: "uuid", required: true },
];

// DELETE /transfers?id=<pair_id> — the user's "this isn't right" action
// on a suggested-or-confirmed pair. Routes through `rejectTransferPair`
// which sets `status='rejected'` (not `is_deleted=TRUE`): the engine
// remembers the rejection and won't re-suggest THIS pair, but the two
// transactions remain eligible for other counterparts. Soft-deletion
// is reserved for the system cascade (when a transaction itself is
// removed).
export const rejectTransferRoute = new Route("DELETE", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  const fieldsResult = validateFields(req.query, REJECT_TRANSFER_QUERY_SPEC);
  if (!fieldsResult.success) return validationError(fieldsResult.error!);

  await rejectTransferPair(user, idResult.data!);

  return { status: "success" };
});
