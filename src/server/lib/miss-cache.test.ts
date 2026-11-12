import { describe, expect, it } from "bun:test";
import { createMissCache, MISS_CACHE_TTL_MS } from "./miss-cache";

describe("createMissCache", () => {
  it("defaults to the shared 5-minute TTL", () => {
    expect(MISS_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("reports a miss as recent right after remembering it", () => {
    const cache = createMissCache();
    expect(cache.isRecentMiss("NOPE")).toBe(false);
    cache.rememberMiss("NOPE");
    expect(cache.isRecentMiss("NOPE")).toBe(true);
    expect(cache.isRecentMiss("OTHER")).toBe(false);
  });

  it("expires a miss once the TTL has passed", () => {
    const cache = createMissCache(1000);
    cache.rememberMiss("NOPE");
    cache.prune(Date.now() + 1001);
    expect(cache.isRecentMiss("NOPE")).toBe(false);
  });

  it("keeps a miss the prune pass has not aged out yet", () => {
    const cache = createMissCache(1000);
    cache.rememberMiss("NOPE");
    cache.prune(Date.now() + 999);
    expect(cache.isRecentMiss("NOPE")).toBe(true);
  });

  it("clears all remembered misses", () => {
    const cache = createMissCache();
    cache.rememberMiss("A");
    cache.rememberMiss("B");
    cache.clear();
    expect(cache.isRecentMiss("A")).toBe(false);
    expect(cache.isRecentMiss("B")).toBe(false);
  });

  it("keeps instances independent", () => {
    const a = createMissCache();
    const b = createMissCache();
    a.rememberMiss("NOPE");
    expect(b.isRecentMiss("NOPE")).toBe(false);
  });
});
