import { describe, test, expect } from "bun:test";
import {
  HoldingValueSummary,
  HoldingValueHistory,
  HoldingsValueData,
} from "./Calcuations";
import { ViewDate } from "../../../common/utils";

describe("HoldingValueSummary", () => {
  test("should initialize with default values", () => {
    const summary = new HoldingValueSummary();
    expect(summary.value).toBe(0);
    expect(summary.costBasis).toBeNull();
    expect(summary.quantity).toBe(0);
    expect(summary.price).toBe(0);
    expect(summary.security_id).toBe("");
    expect(summary.account_id).toBe("");
    expect(summary.costBasisInferred).toBe(false);
  });

  test("should initialize with provided values", () => {
    const summary = new HoldingValueSummary({
      value: 1000,
      costBasis: 800,
      quantity: 10,
      price: 100,
      security_id: "sec1",
      account_id: "acc1",
      costBasisInferred: true,
    });
    expect(summary.value).toBe(1000);
    expect(summary.costBasis).toBe(800);
    expect(summary.quantity).toBe(10);
    expect(summary.price).toBe(100);
    expect(summary.security_id).toBe("sec1");
    expect(summary.account_id).toBe("acc1");
    expect(summary.costBasisInferred).toBe(true);
  });

  describe("unrealizedGain", () => {
    test("should return null when costBasis is null", () => {
      const summary = new HoldingValueSummary({ value: 1000, costBasis: null });
      expect(summary.unrealizedGain).toBeNull();
    });

    test("should calculate positive gain", () => {
      const summary = new HoldingValueSummary({ value: 1000, costBasis: 800 });
      expect(summary.unrealizedGain).toBe(200);
    });

    test("should calculate negative gain (loss)", () => {
      const summary = new HoldingValueSummary({ value: 700, costBasis: 800 });
      expect(summary.unrealizedGain).toBe(-100);
    });

    test("should handle zero gain", () => {
      const summary = new HoldingValueSummary({ value: 800, costBasis: 800 });
      expect(summary.unrealizedGain).toBe(0);
    });
  });

  describe("returnPercent", () => {
    test("should return null when costBasis is null", () => {
      const summary = new HoldingValueSummary({ value: 1000, costBasis: null });
      expect(summary.returnPercent).toBeNull();
    });

    test("should return null when costBasis is 0", () => {
      const summary = new HoldingValueSummary({ value: 1000, costBasis: 0 });
      expect(summary.returnPercent).toBeNull();
    });

    test("should calculate positive return percentage", () => {
      const summary = new HoldingValueSummary({ value: 1200, costBasis: 1000 });
      expect(summary.returnPercent).toBe(20);
    });

    test("should calculate negative return percentage", () => {
      const summary = new HoldingValueSummary({ value: 800, costBasis: 1000 });
      expect(summary.returnPercent).toBe(-20);
    });
  });

  describe("isCostBasisEstimated", () => {
    test("should return false when costBasisInferred is false", () => {
      const summary = new HoldingValueSummary({ costBasisInferred: false });
      expect(summary.isCostBasisEstimated).toBe(false);
    });

    test("should return true when costBasisInferred is true", () => {
      const summary = new HoldingValueSummary({ costBasisInferred: true });
      expect(summary.isCostBasisEstimated).toBe(true);
    });
  });
});

describe("HoldingValueHistory", () => {
  test("should initialize empty", () => {
    const history = new HoldingValueHistory();
    expect(history.getData()).toEqual({});
    expect(history.getRange()).toBeUndefined();
    expect(history.startDate).toBeUndefined();
    expect(history.endDate).toBeUndefined();
  });

  test("should set and get values by date", () => {
    const history = new HoldingValueHistory();
    const date = new Date("2026-01-15");
    const summary = new HoldingValueSummary({ value: 1000 });

    history.set(date, summary);
    expect(history.get(date)?.value).toBe(1000);
  });

  test("should group by month (same month, different days)", () => {
    const history = new HoldingValueHistory();
    const date1 = new Date("2026-01-05");
    const date2 = new Date("2026-01-25");
    const summary1 = new HoldingValueSummary({ value: 1000 });
    const summary2 = new HoldingValueSummary({ value: 1100 });

    history.set(date1, summary1);
    history.set(date2, summary2);

    // Should overwrite - same month
    expect(history.get(date1)?.value).toBe(1100);
    expect(history.get(date2)?.value).toBe(1100);
  });

  test("should track date range", () => {
    const history = new HoldingValueHistory();
    const date1 = new Date("2026-01-15");
    const date2 = new Date("2026-03-15");
    const date3 = new Date("2025-12-15");

    history.set(date1, new HoldingValueSummary({ value: 100 }));
    const range1 = history.getRange();
    expect(range1?.[0].getTime()).toBe(date1.getTime());
    expect(range1?.[1].getTime()).toBe(date1.getTime());

    history.set(date2, new HoldingValueSummary({ value: 200 }));
    const range2 = history.getRange();
    expect(range2?.[0].getTime()).toBe(date1.getTime());
    expect(range2?.[1].getTime()).toBe(date2.getTime());

    history.set(date3, new HoldingValueSummary({ value: 50 }));
    const range3 = history.getRange();
    expect(range3?.[0].getTime()).toBe(date3.getTime());
    expect(range3?.[1].getTime()).toBe(date2.getTime());
  });

  test("should return undefined for missing dates", () => {
    const history = new HoldingValueHistory();
    const date = new Date("2026-01-15");
    expect(history.get(date)).toBeUndefined();
  });

  test("getData should return a copy of the data", () => {
    const history = new HoldingValueHistory();
    history.set(new Date("2026-01-15"), new HoldingValueSummary({ value: 100 }));
    const data = history.getData();
    expect(data).not.toBe(history.getData()); // Different reference
    expect(data["2026-01"]).toBeDefined();
  });

  describe("toArray", () => {
    test("should convert history to array indexed by span from viewDate", () => {
      const history = new HoldingValueHistory();
      const jan = new Date("2026-01-15");
      const feb = new Date("2026-02-15");
      const mar = new Date("2026-03-15");

      history.set(jan, new HoldingValueSummary({ value: 100 }));
      history.set(feb, new HoldingValueSummary({ value: 200 }));
      history.set(mar, new HoldingValueSummary({ value: 300 }));

      const viewDate = new ViewDate("month", mar);
      const arr = history.toArray(viewDate);

      expect(arr[0]?.value).toBe(300); // March (current)
      expect(arr[1]?.value).toBe(200); // February (1 month ago)
      expect(arr[2]?.value).toBe(100); // January (2 months ago)
    });
  });
});

describe("HoldingsValueData", () => {
  const createSummary = (
    value: number,
    accountId: string,
    costBasis: number | null = null
  ) =>
    new HoldingValueSummary({
      value,
      account_id: accountId,
      costBasis,
      security_id: "sec1",
    });

  test("should initialize empty", () => {
    const data = new HoldingsValueData();
    expect(data.size).toBe(0);
    expect(data.getEntries()).toEqual([]);
    expect(data.getAllHoldingIds()).toEqual([]);
  });

  test("should set and get holding value by date", () => {
    const data = new HoldingsValueData();
    const date = new Date("2026-01-15");
    const holdingId = "acc1_sec1";

    data.set(holdingId, date, createSummary(1000, "acc1"));

    expect(data.getHoldingValue(holdingId, date)).toBe(1000);
    expect(data.size).toBe(1);
  });

  test("should set history directly", () => {
    const data = new HoldingsValueData();
    const holdingId = "acc1_sec1";
    const history = new HoldingValueHistory();
    history.set(new Date("2026-01-15"), createSummary(1000, "acc1"));

    data.set(holdingId, history);

    expect(data.getHoldingValue(holdingId, new Date("2026-01-15"))).toBe(1000);
  });

  test("should get holding price", () => {
    const data = new HoldingsValueData();
    const date = new Date("2026-01-15");
    const holdingId = "acc1_sec1";

    data.set(
      holdingId,
      date,
      new HoldingValueSummary({ value: 1000, price: 100, account_id: "acc1" })
    );

    expect(data.getHoldingPrice(holdingId, date)).toBe(100);
  });

  test("should get holding cost basis", () => {
    const data = new HoldingsValueData();
    const date = new Date("2026-01-15");
    const holdingId = "acc1_sec1";

    data.set(holdingId, date, createSummary(1000, "acc1", 800));

    expect(data.getHoldingCostBasis(holdingId, date)).toBe(800);
  });

  test("should get holding unrealized gain", () => {
    const data = new HoldingsValueData();
    const date = new Date("2026-01-15");
    const holdingId = "acc1_sec1";

    data.set(holdingId, date, createSummary(1000, "acc1", 800));

    expect(data.getHoldingUnrealizedGain(holdingId, date)).toBe(200);
  });

  describe("aggregation methods", () => {
    test("getAccountTotalValue should sum all holdings for an account", () => {
      const data = new HoldingsValueData();
      const date = new Date("2026-01-15");

      data.set("acc1_sec1", date, createSummary(1000, "acc1"));
      data.set("acc1_sec2", date, createSummary(500, "acc1"));
      data.set("acc2_sec1", date, createSummary(2000, "acc2"));

      expect(data.getAccountTotalValue("acc1", date)).toBe(1500);
      expect(data.getAccountTotalValue("acc2", date)).toBe(2000);
      expect(data.getAccountTotalValue("acc3", date)).toBe(0);
    });

    test("getAccountUnrealizedGain should sum gains for account holdings", () => {
      const data = new HoldingsValueData();
      const date = new Date("2026-01-15");

      data.set("acc1_sec1", date, createSummary(1000, "acc1", 800)); // +200
      data.set("acc1_sec2", date, createSummary(500, "acc1", 600)); // -100

      expect(data.getAccountUnrealizedGain("acc1", date)).toBe(100);
    });

    test("getAccountUnrealizedGain should return null if no holdings have cost basis", () => {
      const data = new HoldingsValueData();
      const date = new Date("2026-01-15");

      data.set("acc1_sec1", date, createSummary(1000, "acc1", null));

      expect(data.getAccountUnrealizedGain("acc1", date)).toBeNull();
    });

    test("getAccountUnrealizedGain should skip holdings without cost basis", () => {
      const data = new HoldingsValueData();
      const date = new Date("2026-01-15");

      data.set("acc1_sec1", date, createSummary(1000, "acc1", 800)); // +200
      data.set("acc1_sec2", date, createSummary(500, "acc1", null)); // skipped

      expect(data.getAccountUnrealizedGain("acc1", date)).toBe(200);
    });
  });

  describe("discovery methods", () => {
    test("getHoldingsForAccount should return holding ids for account", () => {
      const data = new HoldingsValueData();
      const date = new Date("2026-01-15");

      data.set("acc1_sec1", date, createSummary(1000, "acc1"));
      data.set("acc1_sec2", date, createSummary(500, "acc1"));
      data.set("acc2_sec1", date, createSummary(2000, "acc2"));

      const acc1Holdings = data.getHoldingsForAccount("acc1");
      expect(acc1Holdings).toContain("acc1_sec1");
      expect(acc1Holdings).toContain("acc1_sec2");
      expect(acc1Holdings).not.toContain("acc2_sec1");
      expect(acc1Holdings.length).toBe(2);
    });

    test("getAllHoldingIds should return all holding ids", () => {
      const data = new HoldingsValueData();
      const date = new Date("2026-01-15");

      data.set("acc1_sec1", date, createSummary(1000, "acc1"));
      data.set("acc2_sec1", date, createSummary(2000, "acc2"));

      const ids = data.getAllHoldingIds();
      expect(ids).toContain("acc1_sec1");
      expect(ids).toContain("acc2_sec1");
      expect(ids.length).toBe(2);
    });

    test("getDateRange should return min and max dates across all holdings", () => {
      const data = new HoldingsValueData();

      data.set("acc1_sec1", new Date("2026-01-15"), createSummary(100, "acc1"));
      data.set("acc1_sec1", new Date("2026-03-15"), createSummary(300, "acc1"));
      data.set("acc2_sec1", new Date("2025-12-15"), createSummary(50, "acc2"));

      const range = data.getDateRange();
      expect(range).toBeDefined();
      expect(range![0].getFullYear()).toBe(2025);
      expect(range![0].getMonth()).toBe(11); // December
      expect(range![1].getFullYear()).toBe(2026);
      expect(range![1].getMonth()).toBe(2); // March
    });

    test("getDateRange should return undefined when empty", () => {
      const data = new HoldingsValueData();
      expect(data.getDateRange()).toBeUndefined();
    });
  });

  test("forEach should iterate over all holdings", () => {
    const data = new HoldingsValueData();
    const date = new Date("2026-01-15");

    data.set("acc1_sec1", date, createSummary(1000, "acc1"));
    data.set("acc2_sec1", date, createSummary(2000, "acc2"));

    const visited: string[] = [];
    data.forEach((_, id) => visited.push(id));

    expect(visited).toContain("acc1_sec1");
    expect(visited).toContain("acc2_sec1");
    expect(visited.length).toBe(2);
  });

  test("getHistory should create new history if not exists", () => {
    const data = new HoldingsValueData();
    const history = data.getHistory("new_holding");

    expect(history).toBeInstanceOf(HoldingValueHistory);
    expect(data.size).toBe(1);
  });
});
