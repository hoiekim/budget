import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Probe for the build-posture guard test: bundle the real server
// entrypoint exactly the way src/server/pack.ts does, then report the
// NODE_ENV posture Bun.build folded into the bundle. Runs in a child
// process because Bun.build reads the environment it started with —
// mutating process.env in-process does not change what gets folded.
const root = path.resolve(import.meta.dir, "..");
const outdir = mkdtempSync(path.join(tmpdir(), "build-posture-"));
try {
  const result = await Bun.build({
    entrypoints: [path.resolve(root, "src/server/start.ts")],
    outdir,
    target: "bun",
    external: ["bcrypt", "pg", "plaid"],
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const file = readdirSync(outdir).find((f) => f.endsWith(".js"));
  if (!file) {
    console.error("no bundle output");
    process.exit(1);
  }
  const text = readFileSync(path.join(outdir, file), "utf8");
  const logger = text.match(/function isProduction\(\) \{\n  return (true|false);\n\}/)?.[1];
  const start = text.match(/var isProduction2 = (true|false);/)?.[1];
  console.log(`logger=${logger ?? "?"} start=${start ?? "?"}`);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
