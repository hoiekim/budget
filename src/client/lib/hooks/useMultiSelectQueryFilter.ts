import { useCallback, useMemo } from "react";
import { PATH, useAppContext } from "client";

interface FilterOption<T extends string> {
  value: T;
  label: string;
}

interface UseMultiSelectQueryFilterResult<T extends string> {
  /** Canonicalized to `Object.keys(labels)` order so the URL is stable regardless of click sequence. */
  selected: T[];
  /** Toggles membership of `t` in the URL param. Empty selection removes the param. */
  toggle: (t: T) => void;
  /** Clears the URL param entirely. */
  clearAll: () => void;
  /** Pre-zipped `{ value, label }` array for direct iteration in the JSX. Guaranteed
   * to be in sync with `selected` — the same `labels` record supplies both. */
  options: FilterOption<T>[];
}

/**
 * URL-first multi-select filter hook. Reads the current selection from
 * `router.getActiveParams(targetPath)` (comma-separated), validates
 * against the keys of `labels`, and provides `toggle` / `clearAll`
 * writers that preserve canonical (label-declaration) order in the
 * serialized URL.
 *
 * The `labels` record is the single source of truth: the allowed values
 * are `Object.keys(labels)`, and the returned `options` array zips each
 * value with its display label. That makes value/label consistency a
 * compile-time property — adding a new `T` to the union forces adding
 * a `labels` entry, and the hook picks it up automatically.
 *
 * `targetPath` must be the {@link PATH} of the page/component that owns
 * this hook call — it feeds `router.getActiveParams` so that when this
 * component is the OUTGOING page during a narrow-screen animated
 * transition (`path` still holds the outgoing route) the reader picks
 * up `params` (still holds the outgoing URL, so the dropdown label /
 * chip list keep rendering the caller's own filter as it slides out),
 * and when this component is the INCOMING page (`path` still holds
 * the outgoing route, so `path !== targetPath`) it picks up
 * `incomingParams` (the destination URL) — otherwise the dropdown
 * label would flash "All Xxx" for the ~300ms before the delayed
 * `setParams` fires. See the JSDoc on `router.getActiveParams` for
 * the underlying state model.
 *
 * Passing a sibling page's PATH silently makes the dropdown read from
 * `incomingParams` at steady-state under narrow, which reads as "the
 * dropdown never updates from the URL." The WRITER (`toggle` /
 * `clearAll`) always writes through the live `router.params`; a click
 * mid-transition should update the destination URL, not the outgoing
 * one.
 *
 * Consumer contract: `labels` should be a stable (module-level) object
 * — passing a fresh reference every render breaks memoized comparisons
 * but won't corrupt the URL.
 */
export function useMultiSelectQueryFilter<T extends string>(
  paramKey: string,
  labels: Record<T, string>,
  targetPath: PATH,
): UseMultiSelectQueryFilterResult<T> {
  const { router } = useAppContext();
  const { go, path, getActiveParams, params } = router;
  const readParams = getActiveParams(targetPath);

  const allValues = useMemo(() => Object.keys(labels) as T[], [labels]);

  // Memoize on the raw URL string so consumers depending on `selected`
  // (e.g. inside their own `useMemo`) don't re-invalidate on every render
  // — the reference is stable while the URL param doesn't change.
  const raw = readParams.get(paramKey);
  const selected = useMemo(() => {
    if (!raw) return [];
    const present = new Set(raw.split(",").map((p) => p.trim()));
    return allValues.filter((v) => present.has(v));
  }, [raw, allValues]);

  const options = useMemo<FilterOption<T>[]>(
    () => allValues.map((value) => ({ value, label: labels[value] })),
    [allValues, labels],
  );

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

  return { selected, toggle, clearAll, options };
}
