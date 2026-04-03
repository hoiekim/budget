import { describe, test, expect } from "bun:test";
import { BalanceHistory, BalanceData, BudgetHistory, BudgetData } from "./Calculations";
import { ViewDate } from "../../../common/utils";

// ---------------------------------------------------------------------------
// BalanceHistory
// ---------------------------------------------------------------------------

describe("BalanceHistory", () => {
  describe("set / get", () => {
    test("should return undefined for a date that has not been set", () => {
      const history = new BalanceHistory();
      expect(history.get(new Date(2026, 0, 1))).toBeUndefined();
    });

    test("should store and retrieve a balance for a given month", () => {
      const history = new BalanceHistory();
      history.set(new Date(2026, 0, 1), 1000);
      expect(history.get(new Date(2026, 0, 1))).toBe(1000);
    });

    test("should overwrite an existing value when set is called twice for the same month", () => {
      const history = new BalanceHistory();
      history.set(new Date(2026, 0, 1), 1000);
      history.set(new Date(2026, 0, 15), 2000); // same month, different day
      expect(history.get(new Date(2026, 0, 1))).toBe(2000);
    });

    test("should treat different months as independent entries", () => {
      const history = new BalanceHistory();
      history.set(new Date(2026, 0, 1), 100);
      history.set(new Date(2026, 1, 1), 200);
      expect(history.get(new Date(2026, 0, 1))).toBe(100);
      expect(history.get(new Date(2026, 1, 1))).toBe(200);
    });
  });

  describe("add", () => {
    test("should add to a non-existing entry (starts at 0)", () => {
      const history = new BalanceHistory();
      history.add(new Date(2026, 0, 1), 500);
      expect(history.get(new Date(2026, 0, 1))).toBe(500);
    });

    test("should accumulate amounts for the same month", () => {
      const history = new BalanceHistory();
      history.add(new Date(2026, 0, 1), 300);
      history.add(new Date(2026, 0, 1), 200);
      expect(history.get(new Date(2026, 0, 1))).toBe(500);
    });

    test("should handle negative amounts", () => {
      const history = new BalanceHistory();
      history.set(new Date(2026, 0, 1), 1000);
      history.add(new Date(2026, 0, 1), -400);
      expect(history.get(new Date(2026, 0, 1))).toBe(600);
    });
  });

  describe("range tracking", () => {
    test("getRange should be undefined before any entries", () => {
      const history = new BalanceHistory();
      expect(history.getRange()).toBeUndefined();
    });

    test("getRange should reflect the first entry as both start and end", () => {
      const history = new BalanceHistory();
      const date = new Date(2026, 5, 1);
      history.set(date, 100);
      const range = history.getRange();
      expect(range).toBeDefined();
      expect(range![0].getMonth()).toBe(5);
      expect(range![1].getMonth()).toBe(5);
    });

    test("getRange should expand as earlier and later dates are added", () => {
      const history = new BalanceHistory();
      history.set(new Date(2026, 5, 1), 100); // June
      history.set(new Date(2026, 2, 1), 50); // March — earlier
      history.set(new Date(2026, 9, 1), 200); // October — later

      const range = history.getRange();
      expect(range).toBeDefined();
      // March should be start, October should be end
      expect(range![0].getMonth()).toBe(2); // March
      expect(range![1].getMonth()).toBe(9); // October
    });
  });

  describe("toArray", () => {
    test("should map history entries to positions relative to viewDate", () => {
      const history = new BalanceHistory();
      // viewDate = June 2026 (month index 5)
      history.set(new Date(2026, 5, 1), 600); // span 0
      history.set(new Date(2026, 4, 1), 500); // span 1
      history.set(new Date(2026, 3, 1), 400); // span 2

      const viewDate = new ViewDate("month", new Date(2026, 5, 1));
      const arr = history.toArray(viewDate);

      expect(arr[0]).toBe(600);
      expect(arr[1]).toBe(500);
      expect(arr[2]).toBe(400);
    });

    test("should exclude future entries (negative span)", () => {
      const history = new BalanceHistory();
      history.set(new Date(2026, 5, 1), 600); // June — current
      history.set(new Date(2026, 7, 1), 800); // August — future (span -2)

      const viewDate = new ViewDate("month", new Date(2026, 5, 1));
      const arr = history.toArray(viewDate);

      expect(arr[0]).toBe(600);
      expect(arr.length).toBe(1); // August excluded
    });
  });

  describe("constructor with initial data", () => {
    test("should initialize from an AmountByMonth object", () => {
      const history = new BalanceHistory({ "2026-01": 100, "2026-02": 200 });
      expect(history.get(new Date(2026, 0, 1))).toBe(100);
      expect(history.get(new Date(2026, 1, 1))).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// BalanceData
// ---------------------------------------------------------------------------

describe("BalanceData", () => {
  test("size should reflect number of accounts", () => {
    const data = new BalanceData();
    data.set("acc1", new Date(2026, 0, 1), 100);
    data.set("acc2", new Date(2026, 0, 1), 200);
    expect(data.size).toBe(2);
  });

  test("get with date should return stored amount", () => {
    const data = new BalanceData();
    data.set("acc1", new Date(2026, 0, 1), 500);
    expect(data.get("acc1", new Date(2026, 0, 1))).toBe(500);
  });

  test("get without date should return BalanceHistory", () => {
    const data = new BalanceData();
    data.set("acc1", new Date(2026, 0, 1), 500);
    const history = data.get("acc1");
    expect(history).toBeInstanceOf(BalanceHistory);
  });

  test("add should accumulate across calls", () => {
    const data = new BalanceData();
    data.add("acc1", new Date(2026, 0, 1), 300);
    data.add("acc1", new Date(2026, 0, 1), 200);
    expect(data.get("acc1", new Date(2026, 0, 1))).toBe(500);
  });

  test("get on unknown account should return empty BalanceHistory (not throw)", () => {
    const data = new BalanceData();
    const history = data.get("unknown");
    expect(history).toBeInstanceOf(BalanceHistory);
    expect(history.get(new Date(2026, 0, 1))).toBeUndefined();
  });

  test("set with BalanceHistory should store the provided history", () => {
    const data = new BalanceData();
    const history = new BalanceHistory({ "2026-06": 999 });
    data.set("acc1", history);
    expect(data.get("acc1", new Date(2026, 5, 1))).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// BudgetHistory
// ---------------------------------------------------------------------------

describe("BudgetHistory", () => {
  describe("set / get", () => {
    test("should initialize a new entry to all-zero BudgetSummary", () => {
      const history = new BudgetHistory();
      const summary = history.get(new Date(2026, 0, 1));
      expect(summary.sorted_amount).toBe(0);
      expect(summary.unsorted_amount).toBe(0);
      expect(summary.number_of_unsorted_items).toBe(0);
      expect(summary.rolled_over_amount).toBe(0);
    });

    test("should store and retrieve a budget summary", () => {
      const history = new BudgetHistory();
      history.set(new Date(2026, 0, 1), { sorted_amount: 500 });
      expect(history.get(new Date(2026, 0, 1)).sorted_amount).toBe(500);
    });
  });

  describe("add", () => {
    test("should accumulate sorted_amount across calls", () => {
      const history = new BudgetHistory();
      history.add(new Date(2026, 0, 1), { sorted_amount: 100 });
      history.add(new Date(2026, 0, 1), { sorted_amount: 250 });
      expect(history.get(new Date(2026, 0, 1)).sorted_amount).toBe(350);
    });

    test("should accumulate number_of_unsorted_items", () => {
      const history = new BudgetHistory();
      history.add(new Date(2026, 0, 1), { number_of_unsorted_items: 2 });
      history.add(new Date(2026, 0, 1), { number_of_unsorted_items: 3 });
      expect(history.get(new Date(2026, 0, 1)).number_of_unsorted_items).toBe(5);
    });

    test("should not affect other months", () => {
      const history = new BudgetHistory();
      history.add(new Date(2026, 0, 1), { sorted_amount: 100 });
      expect(history.get(new Date(2026, 1, 1)).sorted_amount).toBe(0);
    });
  });

  describe("aggregateYear", () => {
    test("should sum sorted_amount and unsorted_amount across all months in the year", () => {
      const history = new BudgetHistory();
      history.add(new Date(2026, 0, 1), { sorted_amount: 100, unsorted_amount: 10 });
      history.add(new Date(2026, 1, 1), { sorted_amount: 200, unsorted_amount: 20 });
      history.add(new Date(2026, 2, 1), { sorted_amount: 150, unsorted_amount: 5 });

      const result = history.aggregateYear(2026);
      expect(result.sorted_amount).toBe(450);
      expect(result.unsorted_amount).toBe(35);
    });

    test("should sum number_of_unsorted_items across months", () => {
      const history = new BudgetHistory();
      history.add(new Date(2026, 0, 1), { number_of_unsorted_items: 3 });
      history.add(new Date(2026, 3, 1), { number_of_unsorted_items: 5 });

      const result = history.aggregateYear(2026);
      expect(result.number_of_unsorted_items).toBe(8);
    });

    test("should use January rolled_over_amount for the year total", () => {
      const history = new BudgetHistory();
      history.add(new Date(2026, 0, 1), { rolled_over_amount: 75 }); // January
      history.add(new Date(2026, 1, 1), { rolled_over_amount: 200 }); // February — ignored

      const result = history.aggregateYear(2026);
      expect(result.rolled_over_amount).toBe(75);
    });

    test("should return 0 for rolled_over_amount if January has no data", () => {
      const history = new BudgetHistory();
      history.add(new Date(2026, 1, 1), { sorted_amount: 100 }); // Only February

      const result = history.aggregateYear(2026);
      expect(result.rolled_over_amount).toBe(0);
    });

    test("should return all zeros for a year with no data", () => {
      const history = new BudgetHistory();
      const result = history.aggregateYear(2025);
      expect(result.sorted_amount).toBe(0);
      expect(result.unsorted_amount).toBe(0);
      expect(result.number_of_unsorted_items).toBe(0);
      expect(result.rolled_over_amount).toBe(0);
    });

    test("should not include data from other years", () => {
      const history = new BudgetHistory();
      history.add(new Date(2025, 11, 1), { sorted_amount: 9999 }); // December 2025
      history.add(new Date(2026, 0, 1), { sorted_amount: 100 }); // January 2026
      history.add(new Date(2027, 0, 1), { sorted_amount: 8888 }); // January 2027

      const result = history.aggregateYear(2026);
      expect(result.sorted_amount).toBe(100);
    });

    test("should aggregate all 12 months correctly", () => {
      const history = new BudgetHistory();
      for (let m = 0; m < 12; m++) {
        history.add(new Date(2026, m, 1), { sorted_amount: 50 });
      }
      const result = history.aggregateYear(2026);
      expect(result.sorted_amount).toBe(600); // 12 * 50
    });
  });

  describe("toArray", () => {
    test("should place entries at the correct span index relative to viewDate", () => {
      const history = new BudgetHistory();
      history.set(new Date(2026, 5, 1), { sorted_amount: 300 }); // June — span 0
      history.set(new Date(2026, 4, 1), { sorted_amount: 200 }); // May — span 1

      const viewDate = new ViewDate("month", new Date(2026, 5, 1));
      const arr = history.toArray(viewDate);

      expect(arr[0].sorted_amount).toBe(300);
      expect(arr[1].sorted_amount).toBe(200);
    });

    test("should exclude entries in future months (negative span)", () => {
      const history = new BudgetHistory();
      history.set(new Date(2026, 5, 1), { sorted_amount: 300 }); // current
      history.set(new Date(2026, 7, 1), { sorted_amount: 999 }); // future

      const viewDate = new ViewDate("month", new Date(2026, 5, 1));
      const arr = history.toArray(viewDate);
      expect(arr.length).toBe(1);
      expect(arr[0].sorted_amount).toBe(300);
    });
  });

  describe("constructor with initial data", () => {
    test("should initialize from a BudgetSummaryByMonth object", () => {
      const history = new BudgetHistory({
        "2026-01": { sorted_amount: 100, unsorted_amount: 5, number_of_unsorted_items: 1, rolled_over_amount: 20 },
      });
      const result = history.aggregateYear(2026);
      expect(result.sorted_amount).toBe(100);
      expect(result.rolled_over_amount).toBe(20);
    });
  });
});

// ---------------------------------------------------------------------------
// BudgetData
// ---------------------------------------------------------------------------

describe("BudgetData", () => {
  test("size should reflect number of budget entries", () => {
    const data = new BudgetData();
    data.set("budget1", new Date(2026, 0, 1), { sorted_amount: 100 });
    data.set("budget2", new Date(2026, 0, 1), { sorted_amount: 200 });
    expect(data.size).toBe(2);
  });

  test("get with date should return BudgetSummary", () => {
    const data = new BudgetData();
    data.set("budget1", new Date(2026, 0, 1), { sorted_amount: 400 });
    const summary = data.get("budget1", new Date(2026, 0, 1));
    expect(summary.sorted_amount).toBe(400);
  });

  test("get without date should return BudgetHistory", () => {
    const data = new BudgetData();
    data.set("budget1", new Date(2026, 0, 1), { sorted_amount: 100 });
    const history = data.get("budget1");
    expect(history).toBeInstanceOf(BudgetHistory);
  });

  test("add should accumulate values for same budget and month", () => {
    const data = new BudgetData();
    data.add("budget1", new Date(2026, 0, 1), { sorted_amount: 100 });
    data.add("budget1", new Date(2026, 0, 1), { sorted_amount: 50 });
    expect(data.get("budget1", new Date(2026, 0, 1)).sorted_amount).toBe(150);
  });

  test("set with BudgetHistory should store the provided history", () => {
    const data = new BudgetData();
    const history = new BudgetHistory({ "2026-06": { sorted_amount: 999, unsorted_amount: 0, number_of_unsorted_items: 0, rolled_over_amount: 0 } });
    data.set("budget1", history);
    expect(data.get("budget1", new Date(2026, 5, 1)).sorted_amount).toBe(999);
  });

  test("get on unknown budget should return empty BudgetHistory (not throw)", () => {
    const data = new BudgetData();
    const history = data.get("unknown");
    expect(history).toBeInstanceOf(BudgetHistory);
  });

  test("forEach should iterate over all budget entries", () => {
    const data = new BudgetData();
    data.set("b1", new Date(2026, 0, 1), { sorted_amount: 100 });
    data.set("b2", new Date(2026, 0, 1), { sorted_amount: 200 });

    const ids: string[] = [];
    data.forEach((_history, id) => ids.push(id));
    expect(ids.sort()).toEqual(["b1", "b2"]);
  });

  test("getEntries should return all [id, BudgetHistory] pairs", () => {
    const data = new BudgetData();
    data.set("b1", new Date(2026, 0, 1), { sorted_amount: 100 });
    const entries = data.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0][0]).toBe("b1");
    expect(entries[0][1]).toBeInstanceOf(BudgetHistory);
  });
});
