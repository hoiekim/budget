// Cursor key: ISO timestamp of the last successful sync's start, minus a
// safety margin. Next sync's delta fetch sends this as `start-date`, so
// the server returns only rows whose `updated >= cursor`. Cleared by
// `clean()`.
const LAST_SYNCED_CURSOR_KEY = "budget:lastSyncedCursor";
// Old localStorage key (pre-delta-sync). Removed on first load below
// so returning users don't carry the dead key forever.
const LEGACY_LAST_SYNCED_AT_KEY = "budget:lastSyncedAt";

/**
 * Bump to send every client down the cold path once: its local cache is
 * purged and everything is re-fetched. Delta sync only carries rows whose
 * `updated` moved, so a server-side change it can't see, such as a hard
 * delete, otherwise stays in every browser until a manual Refresh.
 */
export const CACHE_EPOCH = 1;
const CACHE_EPOCH_KEY = "budget:cacheEpoch";

export const dropLegacyKeys = () => {
  try {
    window.localStorage.removeItem(LEGACY_LAST_SYNCED_AT_KEY);
  } catch {
    // no-op
  }
};

/** The delta cursor, or `null` to force a cold sync. A cursor saved under an older cache epoch counts as missing. */
export const readLastSyncedCursor = (): string | null => {
  try {
    if (window.localStorage.getItem(CACHE_EPOCH_KEY) !== String(CACHE_EPOCH)) return null;
    const raw = window.localStorage.getItem(LAST_SYNCED_CURSOR_KEY);
    if (!raw) return null;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    // Future timestamps (clock skew between sessions) → treat as
    // missing so the next sync widens to a full fetch.
    if (t > Date.now()) return null;
    return raw;
  } catch {
    return null;
  }
};

export const writeLastSyncedCursor = (cursor: string) => {
  try {
    window.localStorage.setItem(LAST_SYNCED_CURSOR_KEY, cursor);
    window.localStorage.setItem(CACHE_EPOCH_KEY, String(CACHE_EPOCH));
  } catch {
    // localStorage can throw in private-mode iOS / over quota. Best
    // effort; next sync without a cursor falls through to the cold
    // path, which is correct but slower.
  }
};

export const removeLastSyncedCursor = () => {
  try {
    window.localStorage.removeItem(LAST_SYNCED_CURSOR_KEY);
  } catch {
    // no-op
  }
};
