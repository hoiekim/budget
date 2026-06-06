import { Route, removeTransferPair, requireUuidQueryString, validationError } from "server";

export const deleteTransferRoute = new Route("DELETE", "/transfers", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  const idResult = requireUuidQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  await removeTransferPair(user, idResult.data!);

  return { status: "success" };
});
