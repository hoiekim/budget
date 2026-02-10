import { Route, deleteSnapshotById } from "server";

export const deleteSnapshotRoute = new Route("DELETE", "/snapshot", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const snapshot_id = req.query.id as string;
  await deleteSnapshotById(user, snapshot_id);

  return { status: "success" };
});
