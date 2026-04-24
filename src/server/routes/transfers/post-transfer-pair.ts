import {
  Route,
  pairTransactions,
  confirmTransferPair,
  requireBodyObject,
  requireStringField,
  validationError,
} from "server";

export const postTransferPairRoute = new Route("POST", "/transfers/pair", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);

  const body = bodyResult.data as Record<string, unknown>;

  // If transfer_pair_id is provided, confirm an existing suggested pair
  if (typeof body.transfer_pair_id === "string") {
    await confirmTransferPair(user, body.transfer_pair_id);
    return { status: "success", body: { transfer_pair_id: body.transfer_pair_id } };
  }

  // Otherwise create a new pairing from two transaction IDs
  const aResult = requireStringField(body, "transaction_id_a");
  if (!aResult.success) return validationError(aResult.error!);

  const bResult = requireStringField(body, "transaction_id_b");
  if (!bResult.success) return validationError(bResult.error!);

  const status =
    body.status === "confirmed" ? "confirmed" : "suggested";

  const pair_id = await pairTransactions(
    user,
    aResult.data!,
    bResult.data!,
    status
  );

  return { status: "success", body: { transfer_pair_id: pair_id } };
});
