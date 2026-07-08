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
  const present = raw ? new Set(raw.split(",").map((p) => p.trim())) : new Set<string>();
  const selected = allValues.filter((v) => present.has(v));

  const write = (next: readonly T[]) => {
    const newParams = new URLSearchParams(params);
    if (next.length === 0) newParams.delete(paramKey);
    else newParams.set(paramKey, allValues.filter((v) => next.includes(v)).join(","));
    go(path, { params: newParams, animate: false });
  };

  const toggle = (t: T) => {
    const set = new Set<T>(selected);
    if (set.has(t)) set.delete(t);
    else set.add(t);
    write(allValues.filter((v) => set.has(v)));
  };

  const clearAll = () => write([]);

  return { selected, toggle, clearAll };
}
