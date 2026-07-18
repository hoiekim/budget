import { Route, getTransferPairs, TransferPair, optionalQueryString, validationError } from "server";

export type TransfersGetResponse = TransferPair[];

export const getTransfersRoute = new Route<TransfersGetResponse>("GET", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  // Opt-in tombstone delivery. Unlike /transactions and /snapshots — which
  // hardcode `includeDeleted: true` because their FE reducers were migrated
  // in the same PR — the transfers FE still full-fetches and replaces its
  // cache wholesale, so it must NOT receive tombstones as active rows.
  // Delivery stays behind this param until the FE hook migrates (#542).
  const includeDeletedResult = optionalQueryString(req, "include-deleted");
  if (!includeDeletedResult.success) return validationError(includeDeletedResult.error!);

  const pairs = await getTransferPairs(user, {
    includeDeleted: includeDeletedResult.data === "true",
  });
  return { status: "success", body: pairs };
});
