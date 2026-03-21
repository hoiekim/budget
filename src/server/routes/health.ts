import { Route } from "server/lib/route";
import { pool } from "server/lib/postgres/client";

export type HealthGetResponse = {
  healthy: boolean;
  checks: Record<string, "ok" | "unhealthy">;
  timestamp: number;
};

export const getHealthRoute = new Route<HealthGetResponse>(
  "GET",
  "/health",
  async (_req, res) => {
    const checks: Record<string, "ok" | "unhealthy"> = {};
    let allHealthy = true;

    try {
      await pool.query("SELECT 1");
      checks.database = "ok";
    } catch {
      checks.database = "unhealthy";
      allHealthy = false;
    }

    if (!allHealthy) res.status(503);
    return {
      status: allHealthy ? "success" : "error",
      body: { healthy: allHealthy, checks, timestamp: Date.now() },
    };
  }
);
