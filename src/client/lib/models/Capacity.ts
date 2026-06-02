import {
  JSONCapacity,
  LocalDate,
  MAX_FLOAT,
  assign,
  excludeEnumeration,
  getDateTimeString,
} from "common";

export type Interval = "year" | "month";

/**
 * Minimal shape `Capacity.getActiveAmount` needs from a child entity to
 * resolve a synced capacity by summing children. Kept as a structural
 * interface (not the full `BudgetFamily` class) so the model stays
 * import-free of higher-level types and so tests can pass arbitrary
 * stubs.
 */
export interface CapacityChildLike {
  getActiveCapacity: (date: Date) => Capacity | undefined;
  getChildren: () => CapacityChildLike[];
}
export const intervals: Interval[] = ["year", "month"];

const generateUUID = (): string => {
  const c = (typeof globalThis !== "undefined" && globalThis.crypto) || undefined;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: RFC 4122 v4 UUID built from getRandomValues (available in all
  // browsers since 2011, no secure-context requirement).
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
};

export class Capacity {
  get id() {
    return this.capacity_id;
  }

  capacity_id!: string;

  get year() {
    // Preserve MAX_FLOAT for infinite capacities to avoid overflow
    if (this.isInfinite) {
      return this.month > 0 ? MAX_FLOAT : -MAX_FLOAT;
    }
    return this.month * 12;
  }

  month = 0;

  active_from?: Date;

  /**
   * When true, the displayed amount for this capacity is the sum of the
   * parent entity's children at the same period — not `this.month`. The
   * stored `month` is treated as an advisory cache and is ignored by
   * `getActiveAmount`. See JSONCapacity docstring for rationale.
   */
  is_synced = false;

  constructor(init?: Partial<Capacity | JSONCapacity>) {
    assign(this, init);
    // Only generate UUID if not provided
    if (!this.capacity_id) {
      this.capacity_id = generateUUID();
    }
    if (typeof this.active_from === "string") {
      this.active_from = new LocalDate(this.active_from);
    }
    excludeEnumeration(this, ["toJSON", "fromInputs", "toInputs", "getActiveAmount"]);
  }

  /**
   * Resolve the displayed amount for this capacity in the requested
   * interval, deriving from children when `is_synced` is set.
   *
   *  - `is_synced = false` (default): returns the stored `this[interval]`
   *    — current behavior, no change for existing rows.
   *  - `is_synced = true`: returns the sum of each child's `getActiveAmount`
   *    at the caller-supplied `date`. Walks recursively so a synced budget
   *    summing synced sections summing concrete categories resolves
   *    correctly. Without `children`, returns 0 (caller didn't provide
   *    context — surface as "empty" rather than silently use the stale
   *    stored `month`).
   *
   * **The `date` parameter is the view date**, not the parent capacity's
   * `active_from`. A budget with a single capacity active_from=2024-01
   * viewed at 2025-06 must query children at 2025-06 to find their
   * currently-applicable capacities — otherwise a child whose capacity
   * changed mid-period gets resolved at the parent's outdated boundary.
   *
   * Infinity (`MAX_FLOAT`) is the sentinel for "no limit". Sum semantics:
   *  - any infinite *positive* child poisons to `+MAX_FLOAT`.
   *  - any infinite *negative* child poisons to `-MAX_FLOAT`.
   *  - mixed signs collapse to whichever appears first in the children
   *    order; this matches the existing "Limited budget" model where
   *    income/expense don't mix at the same level.
   *  - NaN children are skipped (defensive — prevents one corrupted row
   *    from blackholing the entire derived total to NaN).
   */
  getActiveAmount = (
    date: Date,
    interval: Interval,
    children?: CapacityChildLike[],
  ): number => {
    if (!this.is_synced) return this[interval];
    if (!children || children.length === 0) return 0;
    let total = 0;
    for (const child of children) {
      const childCapacity = child.getActiveCapacity(date);
      if (!childCapacity) continue;
      const childAmount = childCapacity.getActiveAmount(date, interval, child.getChildren());
      if (Number.isNaN(childAmount)) continue;
      if (Math.abs(childAmount) === MAX_FLOAT) {
        return childAmount > 0 ? MAX_FLOAT : -MAX_FLOAT;
      }
      total += childAmount;
    }
    return total;
  };

  toJSON = (): JSONCapacity => {
    const active_from = this.active_from && getDateTimeString(this.active_from);
    return { ...this, active_from, is_synced: this.is_synced };
  };

  static fromInputs = (
    capacityInput: Capacity,
    isIncomeInput: boolean,
    isInfiniteInput: boolean,
  ) => {
    const capacity = new Capacity(capacityInput);
    const sign = isIncomeInput ? -1 : 1;
    const value = isInfiniteInput ? MAX_FLOAT : Math.abs(capacityInput.month);
    capacity.month = sign * value;
    return capacity;
  };

  toInputs = () => {
    const capacityInput = new Capacity(this);
    const capacityValue = capacityInput.month;
    const isInfiniteInput = Math.abs(capacityValue) === MAX_FLOAT;
    const isIncomeInput = capacityValue < 0;
    capacityInput.month = isInfiniteInput ? 0 : Math.abs(capacityValue);
    return { capacityInput, isIncomeInput, isInfiniteInput };
  };

  get isInfinite() {
    return Math.abs(this.month) === MAX_FLOAT;
  }

  get isIncome() {
    return this.month < 0;
  }
}

const sortCapacities = (a: Capacity, b: Capacity, order: "asc" | "desc" = "asc") => {
  const sign = order === "asc" ? 1 : -1;
  const activeFromA = a.active_from;
  const activeFromB = b.active_from;
  const factorA = activeFromA ? activeFromA.getTime() : -Infinity;
  const factorB = activeFromB ? activeFromB.getTime() : -Infinity;
  return sign * (factorA - factorB);
};

sortCapacities.asc = (a: Capacity, b: Capacity) => sortCapacities(a, b, "asc");
sortCapacities.desc = (a: Capacity, b: Capacity) => sortCapacities(a, b, "desc");

export { sortCapacities };
