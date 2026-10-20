import { describe, test, expect } from "bun:test";
import { cursorUpdateAfterSync, sortById } from "./sync";

describe("cursorUpdateAfterSync", () => {
  test("advances after a clean sync", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: false,
        idbFailed: false,
        writesSkipped: false,
      }),
    ).toBe("advance");
  });

  test("keeps the cursor when a fetch or a save failed", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: true,
        idbFailed: false,
        writesSkipped: false,
      }),
    ).toBe("keep");
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: false,
        idbFailed: true,
        writesSkipped: false,
      }),
    ).toBe("keep");
  });

  test("keeps the cursor when the unavailable cache dropped a write that reported success", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: false,
        idbFailed: false,
        writesSkipped: true,
      }),
    ).toBe("keep");
  });

  test("clears the cursor when the cold-path purge failed, even if everything after it succeeded", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: true,
        fetchFailed: false,
        idbFailed: false,
        writesSkipped: false,
      }),
    ).toBe("clear");
    expect(
      cursorUpdateAfterSync({
        purgeFailed: true,
        fetchFailed: true,
        idbFailed: true,
        writesSkipped: false,
      }),
    ).toBe("clear");
  });
});

describe("sortById", () => {
  test("orders by UTF-16 code unit, the order IndexedDB returns string keys in", () => {
    // A locale-aware compare would put "a" before "B" and "10" after "9";
    // IndexedDB does neither, and any difference rebuilds every dropdown.
    const rows = ["b", "B", "a", "9", "10"].map((id) => ({ id }));
    expect(sortById(rows, (r) => r.id).map((r) => r.id)).toEqual(["10", "9", "B", "a", "b"]);
  });

  test("leaves its input untouched", () => {
    const rows = [{ id: "b" }, { id: "a" }];
    sortById(rows, (r) => r.id);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
