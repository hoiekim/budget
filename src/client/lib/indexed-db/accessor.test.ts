import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { DB_VERSION, IndexedDbAccessor, StoreName } from "./accessor";

test("the store list changes only together with the database version", () => {
  // A browser that already has the database at this version never runs the
  // upgrade that creates a new store, so every read and clear touching it
  // throws and the app falls back to a cold sync on every load. Changing the
  // stores means bumping DB_VERSION and updating both values here.
  expect({ version: DB_VERSION, stores: Object.values(StoreName) }).toEqual({
    version: 6,
    stores: [
      "institutions",
      "accounts",
      "holdings",
      "securities",
      "transactions",
      "investmentTransactions",
      "splitTransactions",
      "budgets",
      "sections",
      "categories",
      "items",
      "charts",
      "accountSnapshots",
      "holdingSnapshots",
      "securitySnapshots",
      "transfers",
      "recurrings",
      "balanceData",
      "budgetData",
      "capacityData",
      "transactionFamilies",
    ],
  });
});

describe("IndexedDbAccessor without an indexedDB global", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // happy-dom provides no `indexedDB`, so the first open throws a
  // ReferenceError before any request exists. The cache is unavailable by
  // environment, not by failure: the open is quiet, the first write is
  // dropped the way the ones after it are — counted, not thrown — so no
  // `.catch(console.error)` call site prints it on a green run.
  test("a missing indexedDB global takes the unavailable branch quietly", async () => {
    expect(typeof indexedDB).toBe("undefined");

    const accessor = new IndexedDbAccessor("TestDb", 1);
    await accessor.save(StoreName.accounts, "k", {});
    expect(accessor.isAvailable()).toBe(false);
    expect(accessor.skippedWrites).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    // Once unavailable, later writes are dropped silently, not re-opened.
    await accessor.save(StoreName.accounts, "k", {});
    expect(accessor.skippedWrites).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    expect(await accessor.load(StoreName.accounts)).toEqual({});
  });
});
