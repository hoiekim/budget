import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { dateInputValue, isInRange, hasDateCollision, snapshotIdFor } from "./lib";

describe("SnapshotsPage/lib", () => {
  describe("dateInputValue", () => {
    // `bun test` runs at UTC, where reading a Date's local components and
    // slicing its ISO string are the same operation — so the day-shift this
    // function exists to prevent is invisible unless the zone is pinned.
    // Restored after the block; `process.env.TZ` is process-global.
    const originalTZ = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "America/Los_Angeles";
    });
    afterAll(() => {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    });

    it("reads the LOCAL calendar day, not the UTC one", () => {
      // 2026-07-10 23:00 PDT is 2026-07-11 06:00 UTC — the two readings disagree,
      // so a `toISOString().slice(0, 10)` implementation fails the second assert.
      const iso = new Date(2026, 6, 10, 23).toISOString();

      expect(iso.slice(0, 10)).toBe("2026-07-11");
      expect(dateInputValue(iso)).toBe("2026-07-10");
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
