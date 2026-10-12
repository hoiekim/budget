import { afterEach, describe, expect, test } from "bun:test";
import { CACHE_EPOCH, readLastSyncedCursor, writeLastSyncedCursor } from "./sync-cursor";

const CURSOR = "2026-10-01T00:00:00.000Z";

afterEach(() => {
  window.localStorage.clear();
});

describe("sync cursor and cache epoch", () => {
  test("a cursor written now reads back", () => {
    writeLastSyncedCursor(CURSOR);
    expect(readLastSyncedCursor()).toBe(CURSOR);
  });

  test("a cursor saved before the cache epoch existed reads as missing, forcing a cold sync", () => {
    window.localStorage.setItem("budget:lastSyncedCursor", CURSOR);
    expect(readLastSyncedCursor()).toBe(null);
  });

  test("a cursor saved under an older cache epoch reads as missing", () => {
    window.localStorage.setItem("budget:lastSyncedCursor", CURSOR);
    window.localStorage.setItem("budget:cacheEpoch", String(CACHE_EPOCH - 1));
    expect(readLastSyncedCursor()).toBe(null);
  });

  test("the cold sync's own write records the current epoch, so the next sync is warm again", () => {
    window.localStorage.setItem("budget:lastSyncedCursor", CURSOR);
    window.localStorage.setItem("budget:cacheEpoch", String(CACHE_EPOCH - 1));
    expect(readLastSyncedCursor()).toBe(null);
    writeLastSyncedCursor(CURSOR);
    expect(readLastSyncedCursor()).toBe(CURSOR);
  });
});
