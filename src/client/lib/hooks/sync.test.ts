import { describe, test, expect } from "bun:test";
import { cursorUpdateAfterSync } from "./sync";

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
