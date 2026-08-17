import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import {
  dateInputValue,
  isInRange,
  hasDateCollision,
  snapshotIdFor,
  dateFromSnapshotId,
} from "./lib";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

describe("SnapshotsPage/lib", () => {
  describe("dateInputValue", () => {
    it("reads the LOCAL calendar day, not the UTC one", () => {
      // Reading a Date's local components and slicing its ISO string are the
      // same operation at UTC, which is where CI runs — so this guarantee is
      // untestable in-process without pinning the zone, and pinning
      // `process.env.TZ` in-process leaks into every suite that runs after
      // this one (it shifted two unrelated date tests by a day). Pin it in a
      // child process instead, where it cannot escape.
      //
      // 2026-07-10 23:00 PDT is 2026-07-11 06:00 UTC: the local and UTC days
      // disagree, so a `toISOString().slice(0, 10)` implementation fails here.
      const script = [
        'import { dateInputValue } from "./src/client/pages/SnapshotsPage/lib";',
        "const iso = new Date(2026, 6, 10, 23).toISOString();",
        "console.log(JSON.stringify({ iso, rendered: dateInputValue(iso) }));",
      ].join("\n");

      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: ["bun", "-e", script],
        cwd: REPO_ROOT,
        env: { ...process.env, TZ: "America/Los_Angeles" },
      });
      expect(exitCode, stderr.toString()).toBe(0);

      const { iso, rendered } = JSON.parse(stdout.toString());
      // The fixture only proves anything if the two readings really do differ.
      expect(iso.slice(0, 10)).toBe("2026-07-11");
      expect(rendered).toBe("2026-07-10");
    });

    it("returns '' for an empty string", () => {
      expect(dateInputValue("")).toBe("");
    });

    it("falls back to the first 10 chars when the value is not a real date", () => {
      expect(dateInputValue("2026-07-10-garbage")).toBe("2026-07-10");
    });
  });

  describe("isInRange", () => {
    const start = new Date("2026-07-01T00:00:00");
    const end = new Date("2026-07-31T23:59:59");

    it("includes a date inside the range (inclusive bounds)", () => {
      expect(isInRange(new Date("2026-07-15T00:00:00").toISOString(), start, end)).toBe(true);
      expect(isInRange(start.toISOString(), start, end)).toBe(true);
    });

    it("excludes dates before the start and after the end", () => {
      expect(isInRange(new Date("2026-06-30T00:00:00").toISOString(), start, end)).toBe(false);
      expect(isInRange(new Date("2026-08-01T00:00:00").toISOString(), start, end)).toBe(false);
    });
  });

  describe("snapshotIdFor", () => {
    it("mirrors the server's `${account_id}-${YYYYMMDD}` derivation", () => {
      expect(snapshotIdFor("a", "2026-07-10")).toBe("a-20260710");
    });
  });

  describe("dateFromSnapshotId", () => {
    it("reads back the day snapshotIdFor encoded", () => {
      expect(dateFromSnapshotId("a-20260710")).toBe("2026-07-10");
      expect(dateFromSnapshotId(snapshotIdFor("acct-1", "2026-12-31"))).toBe("2026-12-31");
    });

    it("survives an account id that itself contains dashes and digits", () => {
      expect(dateFromSnapshotId("acct-99-20260710")).toBe("2026-07-10");
    });

    it("returns null for an id that is not the expected shape", () => {
      expect(dateFromSnapshotId("acct-1")).toBe(null);
      expect(dateFromSnapshotId("")).toBe(null);
      // Too few digits — must not be read as a partial date.
      expect(dateFromSnapshotId("a-2026071")).toBe(null);
    });

    it("is the day the row must edit against when the timestamp renders differently", () => {
      // The bypass this exists to close: a row whose stored timestamp renders as
      // 07-09 in this browser but whose id says 07-10. Initialising the row's
      // date from the timestamp would make a balance-only edit look like no date
      // change, skip the collision guard, and re-date the snapshot.
      const id = "a-20260710";
      const stored = new Date(2026, 6, 9, 12).toISOString();
      expect(dateInputValue(stored)).toBe("2026-07-09");
      expect(dateFromSnapshotId(id)).toBe("2026-07-10");
    });
  });

  describe("hasDateCollision", () => {
    const snaps = [
      { id: "a-20260710", date: new Date("2026-07-10T07:00:00Z").toISOString() },
      { id: "a-20260720", date: new Date("2026-07-20T07:00:00Z").toISOString() },
    ];

    it("flags a date already occupied by ANOTHER snapshot", () => {
      // Editing the 07-10 row onto 07-20 collides with the existing 07-20 row.
      expect(hasDateCollision(snaps, "a", "2026-07-20", "a-20260710")).toBe(true);
    });

    it("does not flag the snapshot's own current date (self-exclusion)", () => {
      expect(hasDateCollision(snaps, "a", "2026-07-10", "a-20260710")).toBe(false);
    });

    it("does not flag a free date", () => {
      expect(hasDateCollision(snaps, "a", "2026-07-25", "a-20260710")).toBe(false);
    });

    it("treats a create (no excluded id) as colliding with any matching day", () => {
      expect(hasDateCollision(snaps, "a", "2026-07-10", "")).toBe(true);
      expect(hasDateCollision(snaps, "a", "2026-07-25", "")).toBe(false);
    });

    it("does not confuse another account's snapshot on the same day", () => {
      const mixed = [{ id: "b-20260710", date: new Date("2026-07-10T07:00:00Z").toISOString() }];
      expect(hasDateCollision(mixed, "a", "2026-07-10", "")).toBe(false);
    });

    it("follows the id when the stored timestamp renders as a different day", () => {
      // What a browser east or west of the server sees: the row's id encodes
      // 07-10 (squashed server-local) while its timestamp renders as 07-09
      // locally. A guard that compared rendered dates would report "free" and
      // let the write silently overwrite this row.
      const skewed = [{ id: "a-20260710", date: new Date(2026, 6, 9, 12).toISOString() }];
      expect(dateInputValue(skewed[0].date)).toBe("2026-07-09");
      expect(hasDateCollision(skewed, "a", "2026-07-10", "a-20260720")).toBe(true);
    });
  });
});
