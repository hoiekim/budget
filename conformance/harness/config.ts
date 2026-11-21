/**
 * Where a conformance run points: which server it starts, and the Postgres
 * instance it makes its databases in. Everything is read from the
 * environment, so the same test files run against either server.
 */
import path from "node:path";

export type Target = "bun" | "rust";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const targetOf = (raw: string | undefined): Target => {
  if (raw === undefined || raw === "" || raw === "bun") return "bun";
  if (raw === "rust") return "rust";
  throw new Error(`CONFORMANCE_TARGET must be "bun" or "rust", not "${raw}"`);
};

export const TARGET: Target = targetOf(process.env.CONFORMANCE_TARGET);

/** The command that starts the server under test, run from the repository root. */
export const serverCommand = (): string[] => {
  if (TARGET === "bun") return ["bun", path.join(REPO_ROOT, "src", "server", "start.ts")];
  const explicit = process.env.CONFORMANCE_RUST_BIN;
  return [explicit ? path.resolve(REPO_ROOT, explicit) : path.join(REPO_ROOT, "target", "debug", "budget-server")];
};

/** The directory both servers serve the client from. */
export const CLIENT_DIR = path.join(REPO_ROOT, "src", "client");

export const POSTGRES = {
  host: process.env.CONFORMANCE_PG_HOST || "127.0.0.1",
  port: Number(process.env.CONFORMANCE_PG_PORT || 5432),
  user: process.env.CONFORMANCE_PG_USER || "postgres",
  password: process.env.CONFORMANCE_PG_PASSWORD || "postgres",
};

/** Echo the server's output while tests run. */
export const VERBOSE = process.env.CONFORMANCE_VERBOSE === "1";

/** Where request/response transcripts are written, one file per test file and target. */
export const TRANSCRIPT_DIR = process.env.CONFORMANCE_TRANSCRIPT_DIR
  ? path.resolve(process.env.CONFORMANCE_TRANSCRIPT_DIR)
  : path.join(REPO_ROOT, "conformance", ".transcripts");

export const ADMIN_PASSWORD = "conformance-admin-pw";
export const DEMO_PASSWORD = "conformance-demo-pw";
export const HOST_NAME = "budget.example.test";
