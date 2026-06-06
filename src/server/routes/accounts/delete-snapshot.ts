import { Route, deleteSnapshotById, requireQueryString, validationError } from "server";

export const deleteSnapshotRoute = new Route("DELETE", "/snapshot", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) {
    return validationError(idResult.error!);
  }
  const snapshot_id = idResult.data!;

  await deleteSnapshotById(user, snapshot_id);

  return { status: "success" };
});
