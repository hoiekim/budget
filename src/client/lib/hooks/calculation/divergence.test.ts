import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

describe("oneYearBefore", () => {
  it("lands on the intended day west of UTC", () => {
    // The window start feeds `computeQtyDivergence`, so a day early here
    // runs the 1-year divergence window one day long for every
    // western-zone user. `new Date("YYYY-MM-DD")` parses as UTC midnight
    // while `setFullYear` mutates in local time — pin the zone in a child
    // process (never `process.env.TZ` in-process: it leaks into every
    // suite that runs after this one).
    //
    // A window ending 2026-09-30 must start 2025-09-30; the old
    // UTC-parse formula yields 2025-09-29 in America/Los_Angeles.
    const script = [
      'import { oneYearBefore } from "./src/client/lib/hooks/calculation/divergence";',
      'import { getDateString } from "./src/common/utils/date";',
      "const windowEnd = \"2026-09-30\";",
      "const old = new Date(windowEnd);",
      "old.setFullYear(old.getFullYear() - 1);",
      "console.log(JSON.stringify({ fixed: oneYearBefore(windowEnd), old: getDateString(old) }));",
    ].join("\n");

    const { stdout, stderr, exitCode } = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: REPO_ROOT,
      env: { ...process.env, TZ: "America/Los_Angeles" },
    });
    expect(exitCode, stderr.toString()).toBe(0);

    const { fixed, old } = JSON.parse(stdout.toString());
    // The fixture only proves anything if the two readings really do differ.
    expect(old).toBe("2025-09-29");
    expect(fixed).toBe("2025-09-30");
  });

  it("agrees with the UTC reading in UTC and east of UTC", () => {
    const script = [
      'import { oneYearBefore } from "./src/client/lib/hooks/calculation/divergence";',
      "console.log(JSON.stringify({ fixed: oneYearBefore(\"2026-09-30\") }));",
    ].join("\n");

    for (const tz of ["UTC", "Asia/Seoul"]) {
      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: ["bun", "-e", script],
        cwd: REPO_ROOT,
        env: { ...process.env, TZ: tz },
      });
      expect(exitCode, stderr.toString()).toBe(0);
      expect(JSON.parse(stdout.toString()).fixed).toBe("2025-09-30");
    }
  });
});
