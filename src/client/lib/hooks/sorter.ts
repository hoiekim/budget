import { useLocalStorage } from "client";

class Comparable<T> {
  A: T;
  B: T;
  a: string | number | Date = 0;
  b: string | number | Date = 0;

  constructor(a: T, b: T) {
    this.A = a;
    this.B = b;
  }

  format = (callback: (e: T) => any) => {
    const a = callback(this.A);
    const b = callback(this.B);

    if (
      (typeof a === "number" && typeof b === "number") ||
      (typeof b === "string" && typeof b === "string") ||
      (a instanceof Date && b instanceof Date)
    ) {
      this.a = a;
      this.b = b;
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
type Formatter<T, H> = (e: T, key: keyof H) => any;

export interface Sorter<T = any, H = any> {
  sort: (array: T[], formatter: Formatter<T, H>) => T[];
  setSortBy: SetSortBy<H>;
  getArrow: GetArrow<H>;
  visibles: { [k in keyof H]?: boolean };
  getVisible: GetVisible<H>;
  toggleVisible: ToggleVisible<H>;
}

export const useSorter = <T, H>(
  name: string,
  initialSortings?: Sortings<H>,
  initialVisibles?: Visibles<H>
): Sorter<T, H> => {
  const [sortings, setSortings] = useLocalStorage<Sortings<H>>(
    `map_${name}_sortings`,
    initialSortings || new Map()
  );

  const [visibles, setVisibles] = useLocalStorage<{ [k in keyof H]?: boolean }>(
    `${name}_visibles`,
    initialVisibles || {}
  );

  const sort: Sorter<T, H>["sort"] = (array, formatter) => {
    Array.from(sortings).forEach(async (e) => {
      const [key, option] = e;
      array.sort((a, b) => {
        const comparable = new Comparable(a, b);
        comparable.format((e) => formatter(e, key));

        const isABiggerThanB = comparable.a > comparable.b;
        const aMinusB = comparable.a === comparable.b ? 0 : isABiggerThanB ? 1 : -1;

        let result: number = 0;

        if (option === "ascending") result = aMinusB;
        else result = -aMinusB;
        return result;
      });
    });

    return array;
  };

  const setSortBy: Sorter<T, H>["setSortBy"] = (key) => {
    const existingValue = sortings.get(key);
    const newValue = existingValue === "ascending" ? "descending" : "ascending";
    sortings.delete(key);
    sortings.set(key, newValue);
    setSortings(new Map(sortings));
  };

  const getArrow: Sorter<T, H>["getArrow"] = (key) => {
    switch (sortings.get(key)) {
      case "ascending":
        return "↑";
      case "descending":
        return "↓";
      default:
        return "";
    }
  };

  const getVisible: Sorter<T, H>["getVisible"] = (key) => !!visibles[key];

  const toggleVisible: Sorter<T, H>["toggleVisible"] = (key) => {
    setVisibles({ ...visibles, [key]: !visibles[key] });
  };

  return { sort, setSortBy, getArrow, visibles, getVisible, toggleVisible };
};
