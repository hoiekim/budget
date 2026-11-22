/**
 * Runs the conformance suite against the Bun server, the Rust server, or both,
 * and then compares what the two answered.
 *
 *   bun conformance/run.ts                      # both servers, then compare
 *   bun conformance/run.ts --target rust        # one server
 *   bun conformance/run.ts tests/login.test.ts  # some files (any `bun test` argument passes through)
 *   bun conformance/run.ts --tz America/Los_Angeles
 *   bun conformance/run.ts --release            # the optimized Rust build
 *
 * Needs a reachable Postgres whose user may create databases
 * (CONFORMANCE_PG_HOST / _PORT / _USER / _PASSWORD; default
 * postgres:postgres@127.0.0.1:5432) and the `openssl` command.
 */
import fs from "node:fs";
import path from "node:path";
import { compareTranscripts } from "./compare";
import { ensureCerts } from "./harness/certs";
import { REPO_ROOT, TRANSCRIPT_DIR, type Target } from "./harness/config";

const args = process.argv.slice(2);
const take = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
};
const has = (flag: string): boolean => {
  const at = args.indexOf(flag);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
};

const targetArg = take("--target") ?? "both";
const tz = take("--tz") ?? process.env.TZ ?? "UTC";
const release = has("--release");
const skipCompare = has("--no-compare");
if (!["bun", "rust", "both"].includes(targetArg)) {
  console.error(`--target must be bun, rust or both, not "${targetArg}"`);
  process.exit(2);
}
const targets: Target[] = targetArg === "both" ? ["bun", "rust"] : [targetArg as Target];

const run = async (cmd: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn({ cmd, cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: out + err };
};

const rustBinary = process.env.CONFORMANCE_RUST_BIN ?? path.join("target", release ? "release" : "debug", "budget-server");
if (targets.includes("rust") && !process.env.CONFORMANCE_RUST_BIN) {
  console.log(`Building the Rust server (${release ? "release" : "debug"})…`);
  const build = Bun.spawn({
    cmd: ["cargo", "build", "--bin", "budget-server", ...(release ? ["--release"] : [])],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) process.exit(1);
}

const selected = args.filter((arg) => arg.endsWith(".ts")).map((arg) => path.basename(arg));
for (const target of targets) {
  const dir = path.join(TRANSCRIPT_DIR, target);
  if (selected.length === 0) fs.rmSync(dir, { recursive: true, force: true });
  else for (const file of selected) fs.rmSync(path.join(dir, `${file}.json`), { force: true });
}

// Test paths are given relative to the repository root or to conformance/.
const testArgs = args.map((arg) => (arg.endsWith(".ts") ? arg.replace(/^conformance\//, "") : arg));

// Made here, once, before the suites start side by side: each would otherwise
// make its own set, and one could replace the other's under a running server.
ensureCerts();

console.log(`Running the conformance suite against ${targets.join(" and ")} (TZ=${tz})…`);
const results = await Promise.all(
  targets.map(async (target) => ({
    target,
    ...(await run(["bun", "test", ...testArgs], path.join(REPO_ROOT, "conformance"), {
      CONFORMANCE_TARGET: target,
      CONFORMANCE_RUST_BIN: rustBinary,
      TZ: tz,
    })),
  })),
);

let failed = false;
for (const { target, code, output } of results) {
  console.log(`\n──────── ${target} ────────`);
  // Passing tests are noise at this size; failures and the summary are not.
  const lines = output.split("\n").filter((line) => !line.startsWith("(pass)"));
  console.log(lines.join("\n").trim());
  if (code !== 0) failed = true;
}

if (targets.length === 2 && !skipCompare) {
  console.log("\n──────── bun vs rust ────────");
  const { compared, problems } = compareTranscripts(selected);
  if (problems.length > 0) {
    failed = true;
    console.log(`The servers answered differently in ${problems.length} place(s):\n`);
    for (const problem of problems) console.log(`  ${problem}\n`);
  } else {
    console.log(`Transcripts match across ${compared} test file(s).`);
  }
}

process.exit(failed ? 1 : 0);
