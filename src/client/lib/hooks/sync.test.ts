import { describe, test, expect } from "bun:test";
import { cursorUpdateAfterSync } from "./sync";

describe("cursorUpdateAfterSync", () => {
  test("advances after a clean sync", () => {
    expect(cursorUpdateAfterSync({ purgeFailed: false, fetchFailed: false, idbFailed: false })).toBe(
      "advance",
    );
  });

  test("keeps the cursor when a fetch or a save failed", () => {
    expect(cursorUpdateAfterSync({ purgeFailed: false, fetchFailed: true, idbFailed: false })).toBe(
      "keep",
    );
    expect(cursorUpdateAfterSync({ purgeFailed: false, fetchFailed: false, idbFailed: true })).toBe(
      "keep",
    );
  });

  test("clears the cursor when the cold-path purge failed, even if everything after it succeeded", () => {
    expect(cursorUpdateAfterSync({ purgeFailed: true, fetchFailed: false, idbFailed: false })).toBe(
      "clear",
    );
    expect(cursorUpdateAfterSync({ purgeFailed: true, fetchFailed: true, idbFailed: true })).toBe(
      "clear",
    );
  });
});
