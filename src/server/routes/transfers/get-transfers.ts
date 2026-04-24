import { Route, getTransferPairs } from "server";

export const getTransfersRoute = new Route("GET", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const pairs = await getTransferPairs(user);
  return { status: "success", body: pairs };
});
