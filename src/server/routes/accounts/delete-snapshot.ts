import { Route, deleteSnapshotsByUser } from "server";

export const deleteSnapshotRoute = new Route("DELETE", "/snapshot", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const snapshot_id = req.query.id as string;
  await deleteSnapshotsByUser(user, [{ snapshot: { snapshot_id } }]);

  return { status: "success" };
});
