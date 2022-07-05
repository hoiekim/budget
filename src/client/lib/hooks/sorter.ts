import { useLocalStorage } from "client";

export class Comparable<T> {
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

export type SortingKey<T> = keyof T;
export type Sortings<T> = Map<SortingKey<T>, "ascending" | "descending">;
export type SetSortBy<T> = (key: SortingKey<T>) => void;
export type GetArrow<T> = (key: SortingKey<T>) => "↑" | "↓" | "";

export const useSorter = <T>(
  name: string,
  initial: [SortingKey<T>, "ascending" | "descending"][]
) => {
  const [sortings, setSortings] = useLocalStorage<Sortings<T>>(
    `map_${name}_sortings`,
    new Map(initial)
  );

  const sort = <E>(array: E[], formatter: (e: E, key: SortingKey<T>) => any) => {
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

  const setSortBy = (key: SortingKey<T>) => {
    const existingValue = sortings.get(key);
    const newValue = existingValue === "ascending" ? "descending" : "ascending";
    sortings.delete(key);
    sortings.set(key, newValue);
    setSortings(new Map(sortings));
  };

  const getArrow = (key: SortingKey<T>) => {
    switch (sortings.get(key)) {
      case "ascending":
        return "↑";
      case "descending":
        return "↓";
      default:
        return "";
    }
  };

  return { sort, setSortBy, getArrow };
};
