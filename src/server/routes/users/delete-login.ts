import { Route } from "server";

export const deleteLoginRoute = new Route("DELETE", "/login", async (req) => {
  req.session.user = undefined;
  return { status: "success" };
});
