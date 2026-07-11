import { describe, it, expect } from "bun:test";
import { getDateString } from "common";
import { dateInputValue, isInRange, hasDateCollision } from "./lib";

describe("SnapshotsPage/lib", () => {
  describe("dateInputValue", () => {
    it("renders a stored ISO date as a local YYYY-MM-DD", () => {
      const iso = new Date("2026-07-10T12:00:00Z").toISOString();
      expect(dateInputValue(iso)).toBe(getDateString(new Date(iso)));
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

  describe("hasDateCollision", () => {
    const snaps = [
      { id: "a-20260710", date: new Date("2026-07-10T07:00:00Z").toISOString() },
      { id: "a-20260720", date: new Date("2026-07-20T07:00:00Z").toISOString() },
    ];

    it("flags a date already occupied by ANOTHER snapshot", () => {
      // Editing the 07-10 row onto 07-20 collides with the existing 07-20 row.
      expect(hasDateCollision(snaps, dateInputValue(snaps[1].date), "a-20260710")).toBe(true);
    });

    it("does not flag the snapshot's own current date (self-exclusion)", () => {
      expect(hasDateCollision(snaps, dateInputValue(snaps[0].date), "a-20260710")).toBe(false);
    });

    it("does not flag a free date", () => {
      expect(hasDateCollision(snaps, "2026-07-25", "a-20260710")).toBe(false);
    });

    it("treats a create (no excluded id) as colliding with any matching day", () => {
      expect(hasDateCollision(snaps, dateInputValue(snaps[0].date), "")).toBe(true);
      expect(hasDateCollision(snaps, "2026-07-25", "")).toBe(false);
    });
  });
});
