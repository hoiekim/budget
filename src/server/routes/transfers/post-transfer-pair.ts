import {
  Route,
  pairTransactions,
  confirmTransferPair,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec } from "server";

/**
 * Typed fields on the `POST /transfers/pair` body, checked at the boundary
 * before any of them reach SQL.
 *
 * `pair_id` names the `transaction_pairs.pair_id` `UUID PRIMARY KEY` column:
 * a non-UUID value handed to `WHERE pair_id = $1` raises Postgres `22P02
 * invalid input syntax for type uuid` at the read, throwing out of the
 * route — a 500 plus an alarm for a body the route could have refused with
 * 400. The `uuid` type rejects it here with the standard validation-error
 * body instead.
 */
const TRANSFER_PAIR_BODY_SPEC: FieldSpec[] = [{ path: "pair_id", type: "uuid" }];

/** `transaction_pairs.transaction_id_a/b` are `VARCHAR(255) NOT NULL`. */
const TRANSACTION_ID_MAX_LENGTH = 255;

function requireBoundedStringField(
  body: Record<string, unknown>,
  field: "transaction_id_a" | "transaction_id_b",
) {
  const result = requireStringField(body, field);
  if (!result.success) return result;
  if (result.data!.length > TRANSACTION_ID_MAX_LENGTH) {
    return {
      success: false as const,
      error: `Field ${field} must be at most ${TRANSACTION_ID_MAX_LENGTH} characters`,
    };
  }
  return result;
}

export const postTransferPairRoute = new Route("POST", "/transfers/pair", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);

  const body = bodyResult.data as Record<string, unknown>;

  const fieldsResult = validateFields(body, TRANSFER_PAIR_BODY_SPEC);
  if (!fieldsResult.success) return validationError(fieldsResult.error!);

  // If pair_id is provided, confirm an existing suggested pair
  if (typeof body.pair_id === "string") {
    const result = await confirmTransferPair(user, body.pair_id);
    if (!result.ok) return { status: "failed", message: result.error };
    return { status: "success", body: { pair_id: body.pair_id } };
  }

  // Otherwise create a new pairing from two transaction IDs
  const aResult = requireBoundedStringField(body, "transaction_id_a");
  if (!aResult.success) return validationError(aResult.error!);

  const bResult = requireBoundedStringField(body, "transaction_id_b");
  if (!bResult.success) return validationError(bResult.error!);

  const status =
    body.status === "confirmed" ? "confirmed" : "suggested";

  const result = await pairTransactions(
    user,
    aResult.data!,
    bResult.data!,
    status
  );
  if (!result.ok) return { status: "failed", message: result.error };

  return { status: "success", body: { pair_id: result.pair_id } };
});
