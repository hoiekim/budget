import { test, expect } from "bun:test";
import { DB_VERSION, StoreName } from "./accessor";

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
