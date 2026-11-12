// A negative cache for provider lookups that came back empty, keyed by the
// same identity as the positive cache. Without it a symbol the provider
// does not know is the one lookup that can never be served warm, so
// repeating it costs a rate slot every time while a valid symbol costs
// one only once. The TTL is short because an empty answer can turn into
// a real one within the day — a freshly listed symbol, or today's close
// once the session settles.
//
// Shared by the polygon and yahoo providers (see #951): the TTL is one
// decision here, not two independent literals that can drift.
export const MISS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface MissCache {
  isRecentMiss: (key: string) => boolean;
  rememberMiss: (key: string) => void;
  /** Evict entries older than the TTL as of `now` (the prune stanza's arm). */
  prune: (now: number) => void;
  clear: () => void;
}

export function createMissCache(ttlMs: number = MISS_CACHE_TTL_MS): MissCache {
  const misses = new Map<string, number>();

  const isRecentMiss = (key: string): boolean => {
    const missedAt = misses.get(key);
    if (missedAt === undefined) return false;
    if (Date.now() - missedAt >= ttlMs) {
      misses.delete(key);
      return false;
    }
    return true;
  };

  const rememberMiss = (key: string): void => {
    misses.set(key, Date.now());
  };

  const prune = (now: number): void => {
    for (const [key, missedAt] of misses) {
      if (now - missedAt >= ttlMs) misses.delete(key);
    }
  };

  const clear = (): void => {
    misses.clear();
  };

  return { isRecentMiss, rememberMiss, prune, clear };
}
