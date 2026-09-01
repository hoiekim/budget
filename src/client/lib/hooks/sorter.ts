import { useCallback } from "react";
import { useLocalStorageState } from "client";

class Comparable<T> {
  A: T;
  B: T;
  a: string | number = 0;
  b: string | number = 0;

  constructor(a: T, b: T) {
    this.A = a;
    this.B = b;
  }

  format = (callback: (e: T) => string | number | Date | unknown) => {
    const a = callback(this.A);
    const b = callback(this.B);

    if (
      (typeof a === "number" && typeof b === "number") ||
      (typeof a === "string" && typeof b === "string") ||
      (a instanceof Date && b instanceof Date)
    ) {
      // Compared with `===` below, so a `Date` has to become its instant: two
      // dates on the same day are distinct objects, and `>` on them is false
      // too, which reports `a < b` for a pair and for its reverse.
      this.a = a instanceof Date ? a.getTime() : a;
      this.b = b instanceof Date ? b.getTime() : b;
    } else {
      this.a = 0;
      this.b = 0;
    }
  };
}

type Sortings<H> = Map<keyof H, "ascending" | "descending">;
type SetSortBy<H> = (key: keyof H) => void;
type GetArrow<H> = (key: keyof H) => "↑" | "↓" | "";
type Visibles<H> = { [k in keyof H]?: boolean };
type GetVisible<H> = (key: keyof H) => boolean;
type ToggleVisible<H> = (key: keyof H) => void;
type Formatter<T, H> = (e: T, key: keyof H) => string | number | Date | unknown;

export interface Sorter<H = unknown> {
  setSortBy: SetSortBy<H>;
  getArrow: GetArrow<H>;
  visibles: { [k in keyof H]?: boolean };
  getVisible: GetVisible<H>;
  toggleVisible: ToggleVisible<H>;
  sortings: Sortings<H>;
}

/**
 * Apply a sorting map to an array, in place. Each entry re-sorts the
 * whole array, so — `Array.prototype.sort` being stable — the last entry
 * is the primary key and earlier ones survive as tiebreaks. Exported so
 * a caller's formatter can be tested against the real comparison.
 *
 * The `async` on the `forEach` callback is load-bearing by accident and
 * kept deliberately: it turns a throwing `formatter` into a discarded
 * rejected promise, so the remaining entries still run and the caller
 * gets a partially-sorted array instead of an exception. Dropping it
 * would surface those throws to the render.
 */
export const applySortings = <T, H>(
  array: T[],
  sortings: Sortings<H>,
  formatter: Formatter<T, H>,
): T[] => {
  sortings.forEach(async (option, key) => {
    array.sort((a, b) => {
      const comparable = new Comparable(a, b);
      comparable.format((e) => formatter(e, key));
      const aMinusB = comparable.a === comparable.b ? 0 : comparable.a > comparable.b ? 1 : -1;
      if (option === "ascending") return aMinusB;
      else return -aMinusB;
    });
  });

  return array;
};

export const useSorter = <H>(
  name: string,
  initialSortings?: Sortings<H>,
  initialVisibles?: Visibles<H>
): Sorter<H> => {
  const [sortings, setSortings] = useLocalStorageState<Sortings<H>>(
    `map_${name}_sortings`,
    initialSortings || new Map()
  );

  const [visibles, setVisibles] = useLocalStorageState<{ [k in keyof H]?: boolean }>(
    `${name}_visibles`,
    initialVisibles || {}
  );

  const setSortBy: Sorter<H>["setSortBy"] = useCallback(
    (key) => {
      setSortings((oldSortings) => {
        const newSortings = new Map(oldSortings);
        const existingValue = oldSortings.get(key);
        const newValue = !existingValue
          ? "descending"
          : existingValue === "descending"
          ? "ascending"
          : undefined;
        newSortings.delete(key);
        if (newValue) newSortings.set(key, newValue);
        return newSortings;
      });
    },
    [setSortings]
  );

  const getArrow: Sorter<H>["getArrow"] = useCallback(
    (key) => {
      switch (sortings.get(key)) {
        case "ascending":
          return "↑";
        case "descending":
          return "↓";
        default:
          return "";
      }
    },
    [sortings]
  );

  const getVisible: Sorter<H>["getVisible"] = useCallback((key) => !!visibles[key], [visibles]);

  const toggleVisible: Sorter<H>["toggleVisible"] = useCallback(
    (key) => setVisibles((oldVisibles) => ({ ...oldVisibles, [key]: !oldVisibles[key] })),
    [setVisibles]
  );

  return { setSortBy, getArrow, visibles, getVisible, toggleVisible, sortings };
};
