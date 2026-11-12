import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const PACK = path.join(import.meta.dir, "pack.ts");
const START = path.join(import.meta.dir, "start.ts");
const NODE_ENV_ACCESSOR = path.join(import.meta.dir, "lib", "node-env.ts");

// Unset is how the Dockerfile builds; "production" and "test" are what server reads compare to.
const BUILD_TIME_NODE_ENVS = [undefined, "production", "test"];

const scratch = mkdtempSync(path.join(tmpdir(), "budget-pack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const { NODE_ENV: _, ...envWithoutNodeEnv } = process.env;

// `--no-env-file`: a developer's .env.local must not pick the NODE_ENV a case runs under.
const runBun = (script: string, nodeEnv: string | undefined): string => {
  const { stdout, stderr, exitCode } = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", script],
    env: nodeEnv === undefined ? envWithoutNodeEnv : { ...envWithoutNodeEnv, NODE_ENV: nodeEnv },
  });
  expect(exitCode, stderr.toString()).toBe(0);
  return stdout.toString();
};

let buildCount = 0;

/**
 * Bundles `entrypoint` with pack.ts's settings in a process whose NODE_ENV is
 * `nodeEnv`, and returns the bundle's path.
 */
const bundleUnder = (entrypoint: string, nodeEnv: string | undefined): string => {
  const outdir = path.join(scratch, `build-${buildCount++}`);
  return runBun(
    [
      `import { buildBundle } from ${JSON.stringify(PACK)};`,
      `const result = await buildBundle(${JSON.stringify(entrypoint)}, ${JSON.stringify(outdir)});`,
      `if (!result.success) throw new AggregateError(result.logs, "build failed");`,
      `process.stdout.write(result.outputs[0].path);`,
    ].join("\n"),
    nodeEnv,
  );
};

// Cut to the first differing column, so a minified one-line bundle still reads as something.
const differingLines = (expected: string, actual: string): string[] => {
  const left = expected.split("\n");
  const right = actual.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? "<no line>";
    const b = right[i] ?? "<no line>";
    if (a === b) continue;
    let column = 0;
    while (column < a.length && a[column] === b[column]) column++;
    const from = Math.max(0, column - 40);
    lines.push(`line ${i + 1}: ${a.slice(from, column + 40)} -> ${b.slice(from, column + 40)}`);
  }
  return lines.slice(0, 5);
};

describe("server bundle", () => {
  // Control: the identity check below proves nothing unless a folded read would change the bundle.
  it("holds the build-time NODE_ENV as a literal where a read uses dot access", () => {
    const fixture = path.join(scratch, "dot-access.ts");
    writeFileSync(fixture, "export const nodeEnv = process.env.NODE_ENV;\n");

    const builtForProduction = readFileSync(bundleUnder(fixture, "production"), "utf8");
    const builtWithoutNodeEnv = readFileSync(bundleUnder(fixture, undefined), "utf8");

    expect(builtForProduction).toContain('nodeEnv = "production";');
    expect(builtWithoutNodeEnv).toContain('nodeEnv = "development";');
  }, 30_000);

  it("is the same artifact whatever NODE_ENV the build runs under", () => {
    const bundles = BUILD_TIME_NODE_ENVS.map((nodeEnv) => ({
      nodeEnv,
      text: readFileSync(bundleUnder(START, nodeEnv), "utf8"),
    }));
    const [baseline, ...others] = bundles;
    const folded = others.flatMap(({ nodeEnv, text }) =>
      differingLines(baseline.text, text).map((line) => `built with NODE_ENV=${nodeEnv}: ${line}`),
    );

    expect(folded).toEqual([]);
  }, 30_000);

  it("takes the production posture from the NODE_ENV the bundle runs under", () => {
    const bundle = bundleUnder(NODE_ENV_ACCESSOR, undefined);
    const isProductionAtRuntime = (nodeEnv: string | undefined) =>
      runBun(
        [
          `import { isProduction } from ${JSON.stringify(bundle)};`,
          `process.stdout.write(String(isProduction()));`,
        ].join("\n"),
        nodeEnv,
      );

    expect(isProductionAtRuntime("production")).toBe("true");
    expect(isProductionAtRuntime("development")).toBe("false");
    expect(isProductionAtRuntime(undefined)).toBe("false");
  }, 30_000);
});
