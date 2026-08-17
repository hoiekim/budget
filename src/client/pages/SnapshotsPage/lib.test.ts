import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import {
  dateInputValue,
  isDayInRange,
  hasDateCollision,
  snapshotIdFor,
  dateFromSnapshotId,
  failureMessage,
  dropRowState,
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

  describe("isDayInRange", () => {
    const start = new Date("2026-07-01T00:00:00");
    const end = new Date("2026-07-31T23:59:59");

    it("includes a day inside the range (inclusive bounds)", () => {
      expect(isDayInRange("2026-07-15", start, end)).toBe(true);
      expect(isDayInRange("2026-07-01", start, end)).toBe(true);
      expect(isDayInRange("2026-07-31", start, end)).toBe(true);
    });

    it("excludes days before the start and after the end", () => {
      expect(isDayInRange("2026-06-30", start, end)).toBe(false);
      expect(isDayInRange("2026-08-01", start, end)).toBe(false);
    });

    it("excludes an empty day", () => {
      // Falls out of the lexicographic compare ("" sorts before any real bound)
      // rather than needing its own guard — asserted so a future rewrite that
      // reaches for Date parsing, where "" becomes Invalid Date, goes red here.
      expect(isDayInRange("", start, end)).toBe(false);
    });

    it("files a boundary day by the day itself, not by a zone-shifted instant", () => {
      // At UTC a bare day string and the range bounds are the same instant, so
      // an implementation that re-reads the day as a Date passes here — and CI
      // runs at UTC. Pin a zone behind the server in a child process (never
      // in-process: `process.env.TZ` leaks across suites and reddened CI once
      // already) so this actually protects the change.
      //
      // The row whose id says July 1 belongs to July in any zone. Read as an
      // instant, `new Date("2026-07-01")` is UTC midnight = 2026-06-30 17:00
      // PDT, which sorts before a local-midnight July 1 bound and drops the row
      // into June.
      const script = [
        'import { isDayInRange, dateFromSnapshotId } from "./src/client/pages/SnapshotsPage/lib";',
        'const start = new Date("2026-07-01T00:00:00");',
        'const end = new Date("2026-07-31T23:59:59");',
        'const day = dateFromSnapshotId("acct-20260701");',
        "const shifted = new Date(day);",
        "console.log(JSON.stringify({",
        "  day,",
        "  inRange: isDayInRange(day, start, end),",
        "  asInstantWouldBe: shifted >= start && shifted <= end,",
        "}));",
      ].join("\n");

      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: ["bun", "-e", script],
        cwd: REPO_ROOT,
        env: { ...process.env, TZ: "America/Los_Angeles" },
      });
      expect(exitCode, stderr.toString()).toBe(0);

      const { day, inRange, asInstantWouldBe } = JSON.parse(stdout.toString());
      expect(day).toBe("2026-07-01");
      // The fixture only proves anything if the two readings really do differ.
      expect(asInstantWouldBe).toBe(false);
      expect(inRange).toBe(true);
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

  describe("failureMessage", () => {
    it("shows a domain message from a `failed` response", () => {
      // What the 401 gate returns — the user needs to see this one.
      expect(failureMessage({ status: "failed", message: "Not authenticated." }, "fallback")).toBe(
        "Not authenticated.",
      );
    });

    it("suppresses the browser's own words on a transport failure", () => {
      // `call` returns status "error" with the raw fetch text.
      expect(failureMessage({ status: "error", message: "Failed to fetch" }, "Failed to save")).toBe(
        "Failed to save",
      );
    });

    it("suppresses Route's catch-all error message", () => {
      expect(
        failureMessage({ status: "error", message: "Internal server error" }, "Failed to save"),
      ).toBe("Failed to save");
    });

    it("falls back when there is no response or no message at all", () => {
      expect(failureMessage(undefined, "Failed to save")).toBe("Failed to save");
      expect(failureMessage({ status: "failed" }, "Failed to save")).toBe("Failed to save");
    });
  });

  describe("dropRowState", () => {
    const edit = { value: "10", date: "2026-07-10" };

    it("drops every id when nothing is in flight", () => {
      const prev = { "a-20260710": edit, "a-20260720": { value: "20", date: "2026-07-20" } };
      expect(dropRowState(prev, ["a-20260710", "a-20260720"])).toEqual({});
    });

    it("leaves untouched ids alone", () => {
      const other = { value: "20", date: "2026-07-20" };
      expect(dropRowState({ "a-20260710": edit, "a-20260720": other }, ["a-20260710"])).toEqual({
        "a-20260720": other,
      });
    });

    it("preserves an entry the user changed while the write was in flight", () => {
      // `setEdit` always stores a fresh object, so a reference mismatch means
      // "typed since the request went out" — reverting it would discard input.
      const typedSince = { value: "10", date: "2026-07-15" };
      expect(dropRowState({ "a-20260710": typedSince }, ["a-20260710"], edit)).toEqual({
        "a-20260710": typedSince,
      });
    });

    it("drops the entry the write was built from", () => {
      expect(dropRowState({ "a-20260710": edit }, ["a-20260710"], edit)).toEqual({});
    });

    it("strands nothing when the caller omits the guard for an id-changing save", () => {
      // The row moves to a new key, so preserving anything under the old id
      // would leave state under a key nothing renders — which is exactly the
      // stranded entry that made a later no-op blur re-date the snapshot.
      const typedSince = { value: "10", date: "2026-07-15" };
      const prev = { "a-20260710": typedSince };
      expect(dropRowState(prev, ["a-20260710", "a-20260720"], undefined)).toEqual({});
    });
  });

  describe("hasDateCollision", () => {
    const snaps = ["a-20260710", "a-20260720"];

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
      expect(hasDateCollision(["b-20260710"], "a", "2026-07-10", "")).toBe(false);
    });

    it("follows the id when the stored timestamp renders as a different day", () => {
      // What a browser east or west of the server sees: the row's id encodes
      // 07-10 (squashed server-local) while its timestamp renders as 07-09
      // locally. A guard that compared rendered dates would report "free" and
      // let the write silently overwrite this row.
      const storedRendersAs = dateInputValue(new Date(2026, 6, 9, 12).toISOString());
      expect(storedRendersAs).toBe("2026-07-09");
      expect(hasDateCollision(["a-20260710"], "a", "2026-07-10", "a-20260720")).toBe(true);
    });
  });
});
