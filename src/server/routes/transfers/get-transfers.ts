import { Route, getTransferPairs, TransferPair } from "server";

export type TransfersGetResponse = TransferPair[];

export const getTransfersRoute = new Route<TransfersGetResponse>("GET", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const pairs = await getTransferPairs(user);
  return { status: "success", body: pairs };
});
