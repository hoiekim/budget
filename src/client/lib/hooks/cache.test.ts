// Run with: bun test --preload ./scripts/test-preload.ts cache.test.ts
import { describe, test, expect } from "bun:test";
import { nextStoredValue } from "./cache";

/**
 * `useLocalStorageState`'s key-change resync, driven directly. The hook
 * itself needs a rendered-hook harness this repo does not have, so the
 * decision is exported and pinned here — the same shape as
 * `deriveActiveParams` in `router.ts` and `reconnectDelayMs` in
 * `useServerEvents.ts`.
 */
describe("nextStoredValue", () => {
  test("an unchanged key leaves the caller's state alone", () => {
    const reads: string[] = [];
    const read = (k: string) => {
      reads.push(k);
      return `value-of-${k}`;
    };
    expect(nextStoredValue("transactions_expenses", "transactions_expenses", read)).toBe(null);
    // Reading is a `localStorage.getItem` + `JSON.parse` per render, so
    // the no-change path must not touch it at all.
    expect(reads).toEqual([]);
  });

  test("a changed key resyncs to the new key's stored value", () => {
    const store: Record<string, string> = {
      transactions_expenses: "cash-order",
      transactions_investment_expenses: "investment-order",
    };
    const out = nextStoredValue(
      "transactions_expenses",
      "transactions_investment_expenses",
      (k) => store[k],
    );
    expect(out).toEqual({
      key: "transactions_investment_expenses",
      value: "investment-order",
    });
  });

  test("the resync reads the NEW key, never the previous one", () => {
    const reads: string[] = [];
    nextStoredValue("map_transactions_sortings", "map_transactions_investment_sortings", (k) => {
      reads.push(k);
      return null;
    });
    expect(reads).toEqual(["map_transactions_investment_sortings"]);
  });

  test("a key whose slot is empty resyncs to the read's fallback, not the old value", () => {
    // The cash slot is populated and the investment slot is not. Keeping
    // the old value here is the exact defect: the investment view would
    // render the cash list's ordering and the next write would persist
    // it into the investment slot.
    const store: Record<string, string | undefined> = { map_transactions_sortings: "cash-order" };
    const out = nextStoredValue(
      "map_transactions_sortings",
      "map_transactions_investment_sortings",
      (k) => store[k] ?? "default-order",
    );
    expect(out).toEqual({
      key: "map_transactions_investment_sortings",
      value: "default-order",
    });
  });

  test("a falsy stored value still counts as a resync", () => {
    // `null` / `0` / `""` are legitimate stored values, so the caller
    // discriminates on the returned object, not on its `value`.
    const out = nextStoredValue("a", "b", () => null);
    expect(out).not.toBe(null);
    expect(out?.value).toBe(null);
  });
});
