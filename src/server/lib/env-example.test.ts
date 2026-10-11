import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { REPO_ROOT, extract, filesUnder } from "../../../scripts/env-scan";

/**
 * The two directions ask different questions, so they scan different trees.
 *
 * "Is every read documented?" is about the knobs an operator supplies to the
 * running server, so it scans `src/` plus the healthcheck the runtime image
 * runs as its HEALTHCHECK command. A one-off script's own env surface, and the
 * host's build config, have no business in a deployment's env file.
 *
 * "Is this entry dead?" is about whether anything at all reads the name, so it
 * spans every tree that ships or runs, root files included.
 *
 * Both name their root files rather than scanning the repo root. A directory
 * root's contents are not declared, so the missing-root throw below cannot see
 * them, and the verdict would then differ between this host and the Docker
 * builder, which copies only the root files the `Dockerfile` names.
 */
const SERVER_ROOTS = ["src", "healthcheck.js"];
const ALL_ROOTS = ["src", "scripts", "vite.config.ts", "eslint.config.js", "healthcheck.js"];

/**
 * Files whose reads SNAPSHOT a variable rather than consume it.
 *
 * The test preload records the market-data env so `restoreEnv` can put it back
 * between test files. That is a read of the name and no evidence that anything
 * still uses the variable, so counting it would keep an entry documented
 * forever after its last real consumer was deleted. Its accesses still count
 * for the opaque direction, which is about whether a name can be resolved at
 * all.
 */
const SNAPSHOT_ONLY = ["scripts/test-preload.ts"];

const collect = (roots: string[]) => {
  const read = new Set<string>();
  const opaque: string[] = [];
  for (const file of filesUnder(roots)) {
    const extraction = extract(file);
    const relative = path.relative(REPO_ROOT, file);
    if (!SNAPSHOT_ONLY.includes(relative)) {
      for (const name of extraction.read) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(name)) read.add(name);
      }
    }
    opaque.push(...extraction.opaque);
  }
  return { read, opaque };
};

const documentedVariables = (): Set<string> =>
  new Set(
    [
      ...readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8").matchAll(
        /^#?\s*([A-Z_][A-Z0-9_]*)=/gm
      ),
    ].map((match) => match[1])
  );

/**
 * Names that reach their reader by a route no static extraction can follow,
 * each with the reason. Declaring a name here is the only way it is exempted.
 */
const INDIRECTLY_READ: Record<string, string> = {};

describe(".env.example", () => {
  it("documents every variable the server reads", () => {
    const documented = documentedVariables();
    const undocumented = [...collect(SERVER_ROOTS).read]
      .filter((name) => !documented.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("documents no variable that is never read", () => {
    const { read } = collect(ALL_ROOTS);
    const dead = [...documentedVariables()]
      .filter((name) => !read.has(name) && !(name in INDIRECTLY_READ))
      .sort();
    expect(dead).toEqual([]);
  });

  /**
   * No exemption list, unlike the dead direction: an unfollowable env access is
   * a gap in what the other two assertions can see, so it is fixed at the call
   * site rather than declared. `{ ...process.env }` stays available in tests,
   * which this scan excludes.
   */
  it("has no env access whose variable name it cannot resolve", () => {
    expect(collect(ALL_ROOTS).opaque).toEqual([]);
  });
});
