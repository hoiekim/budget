import { Route, getTransfers, TransferPair } from "server";

export interface TransfersGetResponse {
  transfers: TransferPair[];
}

export const getTransfersRoute = new Route<TransfersGetResponse>(
  "GET",
  "/transfers",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const transfers = await getTransfers(user);

    return {
      status: "success",
      body: { transfers },
    };
  },
);
