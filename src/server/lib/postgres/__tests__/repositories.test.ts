/**
 * End-to-end tests for PostgreSQL repositories.
 * Tests CRUD operations against a real database.
 */

import { ChartType } from "common";
import { pool } from "../client";
import {
  // User functions
  indexUser,
  searchUser,
  getUserById,
  updateUser,
  deleteUser,
  MaskedUser,
  // Budget functions
  getBudgets,
  getBudget,
  createBudget,
  updateBudget,
  deleteBudget,
  getSections,
  createSection,
  updateSection,
  deleteSection,
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  // Account functions
  getAccounts,
  getAccount,
  // Item functions
  getItems,
  getItem,
  // Transaction functions
  getTransactions,
  getTransaction,
  // Chart functions
  getCharts,
  getChart,
  createChart,
  updateChart,
  deleteChart,
  // Snapshot functions
  searchSnapshots,
  getAccountSnapshots,
} from "../repositories";
import { initializeIndex } from "../initialize";

describe("PostgreSQL Repositories End-to-End Tests", () => {
  let testUser: MaskedUser;

  beforeAll(async () => {
    // Ensure tables exist
    await initializeIndex();

    // Get admin user for testing
    const adminUser = await searchUser({ username: "admin" });
    if (!adminUser) {
      throw new Error("Admin user not found - database may not be initialized");
    }
    testUser = { user_id: adminUser.user_id, username: adminUser.username };
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("User Repository", () => {
    const testUsername = `test_user_${Date.now()}`;
    let createdUserId: string;

    test("indexUser creates a new user", async () => {
      const result = await indexUser({
        username: testUsername,
        password: "test_password_123",
      });

      expect(result).toBeDefined();
      expect(result?._id).toBeDefined();
      createdUserId = result!._id;
    });

    test("searchUser finds user by username", async () => {
      const user = await searchUser({ username: testUsername });

      expect(user).toBeDefined();
      expect(user?.username).toBe(testUsername);
      expect(user?.user_id).toBe(createdUserId);
    });

    test("getUserById retrieves user by ID", async () => {
      const user = await getUserById(createdUserId);

      expect(user).toBeDefined();
      expect(user?.user_id).toBe(createdUserId);
      expect(user?.username).toBe(testUsername);
    });

    test("updateUser updates username", async () => {
      const newUsername = `updated_${testUsername}`;
      const success = await updateUser({
        user_id: createdUserId,
        username: newUsername,
      });

      expect(success).toBe(true);

      const user = await getUserById(createdUserId);
      expect(user?.username).toBe(newUsername);
    });

    test("deleteUser soft-deletes user", async () => {
      const success = await deleteUser(createdUserId);
      expect(success).toBe(true);
    });
  });

  describe("Budget Repository", () => {
    let createdBudgetId: string;
    let createdSectionId: string;
    let createdCategoryId: string;

    test("getBudgets returns budgets for user", async () => {
      const budgets = await getBudgets(testUser);

      expect(Array.isArray(budgets)).toBe(true);
      // Should have existing budgets from migration
      expect(budgets.length).toBeGreaterThan(0);
    });

    test("createBudget creates new budget", async () => {
      const result = await createBudget(testUser, {
        name: "Test Budget",
        capacities: [
          { capacity_id: "cap1", month: 1000, active_from: "2026-01" },
          { capacity_id: "cap2", month: 1500, active_from: "2026-02" },
        ],
        roll_over: false,
        iso_currency_code: "USD",
      });

      expect(result).toBeDefined();
      expect(result?.budget_id).toBeDefined();
      createdBudgetId = result!.budget_id;
    });

    test("getBudget retrieves specific budget", async () => {
      const budget = await getBudget(testUser, createdBudgetId);

      expect(budget).toBeDefined();
      expect(budget?.budget_id).toBe(createdBudgetId);
      expect(budget?.name).toBe("Test Budget");
    });

    test("updateBudget updates budget name", async () => {
      const success = await updateBudget(testUser, createdBudgetId, {
        name: "Updated Test Budget",
      });

      expect(success).toBe(true);

      const budget = await getBudget(testUser, createdBudgetId);
      expect(budget?.name).toBe("Updated Test Budget");
    });

    test("createSection creates section in budget", async () => {
      const result = await createSection(testUser, {
        budget_id: createdBudgetId,
        name: "Test Section",
      });

      expect(result).toBeDefined();
      expect(result?.section_id).toBeDefined();
      createdSectionId = result!.section_id;
    });

    test("getSections returns sections for budget", async () => {
      const sections = await getSections(testUser, createdBudgetId);

      expect(Array.isArray(sections)).toBe(true);
      expect(sections.length).toBeGreaterThan(0);
      expect(sections.some((s) => s.section_id === createdSectionId)).toBe(true);
    });

    test("updateSection updates section name", async () => {
      const success = await updateSection(testUser, createdSectionId, {
        name: "Updated Test Section",
      });

      expect(success).toBe(true);
    });

    test("createCategory creates category in section", async () => {
      const result = await createCategory(testUser, {
        section_id: createdSectionId,
        name: "Test Category",
        capacities: [{ capacity_id: "cat1", month: 500, active_from: "2026-01" }],
      });

      expect(result).toBeDefined();
      expect(result?.category_id).toBeDefined();
      createdCategoryId = result!.category_id;
    });

    test("getCategories returns categories for section", async () => {
      const categories = await getCategories(testUser, createdSectionId);

      expect(Array.isArray(categories)).toBe(true);
      expect(categories.length).toBeGreaterThan(0);
    });

    test("updateCategory updates category", async () => {
      const success = await updateCategory(testUser, createdCategoryId, {
        name: "Updated Test Category",
      });

      expect(success).toBe(true);
    });

    test("deleteCategory soft-deletes category", async () => {
      const success = await deleteCategory(testUser, createdCategoryId);
      expect(success).toBe(true);
    });

    test("deleteSection soft-deletes section", async () => {
      const success = await deleteSection(testUser, createdSectionId);
      expect(success).toBe(true);
    });

    test("deleteBudget soft-deletes budget", async () => {
      const success = await deleteBudget(testUser, createdBudgetId);
      expect(success).toBe(true);
    });
  });

  describe("Account Repository", () => {
    test("getAccounts returns accounts for user", async () => {
      const accounts = await getAccounts(testUser);

      expect(Array.isArray(accounts)).toBe(true);
      // Should have existing accounts from migration
      expect(accounts.length).toBeGreaterThan(0);
    });

    test("getAccount returns specific account", async () => {
      const accounts = await getAccounts(testUser);
      if (accounts.length === 0) {
        console.warn("Skipping - no accounts available");
        return;
      }

      const accountId = accounts[0].account_id;
      const account = await getAccount(testUser, accountId);

      expect(account).toBeDefined();
      expect(account?.account_id).toBe(accountId);
    });

    test("account has correct structure", async () => {
      const accounts = await getAccounts(testUser);
      if (accounts.length === 0) return;

      const account = accounts[0];
      // Check that model conversion works correctly
      expect(account).toHaveProperty("account_id");
      expect(account).toHaveProperty("name");
      expect(account).toHaveProperty("type");
      expect(account).toHaveProperty("balances");
      expect(account.balances).toHaveProperty("current");
      expect(account.balances).toHaveProperty("available");
      // Verify numbers are actual numbers, not strings
      expect(typeof account.balances.current).toBe("number");
    });
  });

  describe("Item Repository", () => {
    test("getItems returns items for user", async () => {
      const items = await getItems(testUser);

      expect(Array.isArray(items)).toBe(true);
    });

    test("getItem returns specific item", async () => {
      const items = await getItems(testUser);
      if (items.length === 0) {
        console.warn("Skipping - no items available");
        return;
      }

      const itemId = items[0].item_id;
      const item = await getItem(testUser, itemId);

      expect(item).toBeDefined();
      expect(item?.item_id).toBe(itemId);
    });
  });

  describe("Transaction Repository", () => {
    test("getTransactions returns transactions for user", async () => {
      const transactions = await getTransactions(testUser);

      expect(Array.isArray(transactions)).toBe(true);
      // Should have existing transactions from migration
      expect(transactions.length).toBeGreaterThan(0);
    });

    test("getTransaction returns specific transaction", async () => {
      const transactions = await getTransactions(testUser);
      if (transactions.length === 0) {
        console.warn("Skipping - no transactions available");
        return;
      }

      const txnId = transactions[0].transaction_id;
      const txn = await getTransaction(testUser, txnId);

      expect(txn).toBeDefined();
      expect(txn?.transaction_id).toBe(txnId);
    });

    test("transaction has correct structure", async () => {
      const transactions = await getTransactions(testUser);
      if (transactions.length === 0) return;

      const txn = transactions[0];
      expect(txn).toHaveProperty("transaction_id");
      expect(txn).toHaveProperty("account_id");
      expect(txn).toHaveProperty("amount");
      expect(txn).toHaveProperty("date");
      expect(txn).toHaveProperty("name");
      // Verify amount is a number
      expect(typeof txn.amount).toBe("number");
    });

    test("getTransactions with date range filter", async () => {
      const transactions = await getTransactions(testUser, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      });

      expect(Array.isArray(transactions)).toBe(true);
      // Transactions should all be within date range
      for (const txn of transactions) {
        expect(new Date(txn.date).getFullYear()).toBe(2024);
      }
    });
  });

  describe("Chart Repository", () => {
    let createdChartId: string;

    test("getCharts returns charts for user", async () => {
      const charts = await getCharts(testUser);

      expect(Array.isArray(charts)).toBe(true);
    });

    test("createChart creates new chart", async () => {
      const result = await createChart(testUser, {
        name: "Test Chart",
        type: ChartType.BALANCE,
        configuration: JSON.stringify({ budget_ids: [], account_ids: [] }),
      });

      expect(result).toBeDefined();
      expect(result?.chart_id).toBeDefined();
      createdChartId = result!.chart_id;
    });

    test("getChart retrieves specific chart", async () => {
      const chart = await getChart(testUser, createdChartId);

      expect(chart).toBeDefined();
      expect(chart?.chart_id).toBe(createdChartId);
      expect(chart?.name).toBe("Test Chart");
    });

    test("updateChart updates chart name", async () => {
      const success = await updateChart(testUser, createdChartId, {
        name: "Updated Test Chart",
      });

      expect(success).toBe(true);

      const chart = await getChart(testUser, createdChartId);
      expect(chart?.name).toBe("Updated Test Chart");
    });

    test("deleteChart soft-deletes chart", async () => {
      const success = await deleteChart(testUser, createdChartId);
      expect(success).toBe(true);
    });
  });

  describe("Snapshot Repository", () => {
    test("searchSnapshots returns snapshots", async () => {
      const snapshots = await searchSnapshots(testUser, {});

      expect(Array.isArray(snapshots)).toBe(true);
    });

    test("getAccountSnapshots returns account snapshots", async () => {
      const accounts = await getAccounts(testUser);
      if (accounts.length === 0) {
        console.warn("Skipping - no accounts available");
        return;
      }

      const accountId = accounts[0].account_id;
      const snapshots = await getAccountSnapshots(testUser, { account_id: accountId });

      expect(Array.isArray(snapshots)).toBe(true);
    });
  });

  describe("Model Validation", () => {
    test("UserModel validates required fields", async () => {
      const { UserModel } = await import("../models");

      expect(() => {
        new UserModel({ user_id: "test-id", username: "test" });
      }).not.toThrow();

      expect(() => {
        new UserModel({ username: "test" }); // missing user_id
      }).toThrow();
    });

    test("AccountModel validates required fields", async () => {
      const { AccountModel } = await import("../models");

      expect(() => {
        new AccountModel({
          account_id: "test-id",
          user_id: "user-id",
          item_id: "item-id",
          institution_id: "inst-id",
        });
      }).not.toThrow();
    });

    test("TransactionModel validates required fields", async () => {
      const { TransactionModel } = await import("../models");

      expect(() => {
        new TransactionModel({
          transaction_id: "test-id",
          user_id: "user-id",
          account_id: "account-id",
        });
      }).not.toThrow();
    });
  });

  describe("Data Integrity", () => {
    test("numeric values are returned as numbers, not strings", async () => {
      const accounts = await getAccounts(testUser);
      if (accounts.length === 0) return;

      for (const account of accounts.slice(0, 5)) {
        expect(typeof account.balances.current).toBe("number");
        expect(typeof account.balances.available).toBe("number");
        expect(typeof account.balances.limit).toBe("number");
        expect(Number.isNaN(account.balances.current)).toBe(false);
      }
    });

    test("transactions have numeric amounts", async () => {
      const transactions = await getTransactions(testUser);
      if (transactions.length === 0) return;

      for (const txn of transactions.slice(0, 10)) {
        expect(typeof txn.amount).toBe("number");
        expect(Number.isNaN(txn.amount)).toBe(false);
      }
    });

    test("budgets have valid capacities", async () => {
      const budgets = await getBudgets(testUser);
      if (budgets.length === 0) return;

      for (const budget of budgets) {
        expect(Array.isArray(budget.capacities)).toBe(true);
      }
    });
  });

  describe("Soft Delete Behavior", () => {
    test("deleted items are excluded from normal queries", async () => {
      // Create a budget, delete it, verify it's not in results
      const result = await createBudget(testUser, {
        name: "To Be Deleted",
        capacities: [],
        roll_over: false,
        iso_currency_code: "USD",
      });

      const budgetId = result!.budget_id;

      // Verify it exists
      let budget = await getBudget(testUser, budgetId);
      expect(budget).toBeDefined();

      // Delete it
      await deleteBudget(testUser, budgetId);

      // Verify it's no longer returned
      budget = await getBudget(testUser, budgetId);
      expect(budget).toBeNull();

      // Verify it's not in list
      const budgets = await getBudgets(testUser);
      expect(budgets.some((b) => b.budget_id === budgetId)).toBe(false);
    });
  });
});
