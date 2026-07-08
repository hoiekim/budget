import { useCallback } from "react";
import { useAppContext } from "client";

interface UseMultiSelectQueryFilterResult<T extends string> {
  /** Canonicalized to `allValues` order so the URL is stable regardless of click sequence. */
  selected: T[];
  /** Toggles membership of `t` in the URL param. Empty selection removes the param. */
  toggle: (t: T) => void;
  /** Clears the URL param entirely. */
  clearAll: () => void;
}

/**
 * URL-first multi-select filter hook. Reads the current selection from
 * `router.params.get(paramKey)` (comma-separated), validates against
 * `allValues`, and provides `toggle` / `clearAll` writers that preserve
 * canonical (allValues) order in the serialized URL.
 *
 * Consumer contract: `allValues` should be a stable (module-level) tuple
 * — passing a fresh array every render breaks memoized comparisons but
 * won't corrupt the URL.
 */
export function useMultiSelectQueryFilter<T extends string>(
  paramKey: string,
  allValues: readonly T[],
): UseMultiSelectQueryFilterResult<T> {
  const { router } = useAppContext();
  const { go, path, params } = router;

  const raw = params.get(paramKey);
  const selected = raw
    ? (() => {
        const present = new Set(raw.split(",").map((p) => p.trim()));
        return allValues.filter((v) => present.has(v));
      })()
    : [];

  const toggle = useCallback(
    (t: T) => {
      const rawNow = params.get(paramKey);
      const set = new Set<string>(rawNow ? rawNow.split(",").map((p) => p.trim()) : []);
      if (set.has(t)) set.delete(t);
      else set.add(t);
      const next = allValues.filter((v) => set.has(v));
      const newParams = new URLSearchParams(params);
      if (next.length === 0) newParams.delete(paramKey);
      else newParams.set(paramKey, next.join(","));
      go(path, { params: newParams, animate: false });
    },
    [paramKey, allValues, params, go, path],
  );

  const clearAll = useCallback(() => {
    const newParams = new URLSearchParams(params);
    newParams.delete(paramKey);
    go(path, { params: newParams, animate: false });
  }, [paramKey, params, go, path]);

  return { selected, toggle, clearAll };
}
