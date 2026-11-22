import { Route, getSharing } from "server";
import type { Sharing } from "server";

export type SharingGetResponse = Sharing;

export const getSharingRoute = new Route<SharingGetResponse>("GET", "/sharing", async (req) => {
  const { user } = req.session;
  if (!user) return { status: "failed", message: "Request user is not authenticated." };
  return { status: "success", body: await getSharing(user) };
});
