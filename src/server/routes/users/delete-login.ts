import { Route } from "server";
import { logger } from "server/lib/logger";

export const deleteLoginRoute = new Route("DELETE", "/login", async (req) => {
  req.session.destroy((error) => {
    if (error) {
      logger.error("Failed to destroy session", {}, error);
      throw new Error("Failed to destroy session.");
    }
  });
  return { status: "success" };
});
