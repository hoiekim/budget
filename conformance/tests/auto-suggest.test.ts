/**
 * The hourly category-suggestion job. It runs in the scheduled sync every
 * server start makes, so each case seeds users, budgets, labeled history and
 * unlabeled transactions and splits straight into the database, restarts the
 * server, and reads back what the job stored and logged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, startStack, type Stack } from "../harness";
import {
  localDay,
  seedCategoryTree,
  seedRejection,
  seedSplit,
  seedTransaction,
  shareData,
  splitJson,
  storedSplit,
  storedTransaction,
  transactionJson,
} from "../harness/seed/transactions";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

/** Yesterday: inside the job's one-week window wherever the clock is. */
const RECENT = localDay(-1);
/** Outside the window by days, and never within the ±3-day band of RECENT's day of month. */
const OLD = localDay(-12);

type Tree = { budget_id: string; section_id: string; category_id: string };
type Row = Record<string, unknown>;

/** A transaction the user confirmed: their labeled history. */
const confirmed = (user_id: string, tree: Tree, row: Row) =>
  seedTransaction(stack, user_id, {
    date: RECENT,
    name: null,
    label_category_id: tree.category_id,
    label_budget_id: tree.budget_id,
    label_category_confidence: 1,
    ...row,
  });

/** A transaction no one labeled. */
const unlabeled = (user_id: string, row: Row) =>
  seedTransaction(stack, user_id, { date: RECENT, name: null, label_category_confidence: null, ...row });

const labelOf = async (transaction_id: string) => {
  const row = await storedTransaction(stack, transaction_id);
  return [row.label_category_id, row.label_budget_id, row.label_category_confidence];
};
const splitLabelOf = async (split_transaction_id: string) => {
  const row = await storedSplit(stack, split_transaction_id);
  return [row.label_category_id, row.label_budget_id, row.label_category_confidence];
};
const suggestion = (tree: Tree, confidence: number) => [tree.category_id, tree.budget_id, confidence];
const UNLABELED = [null, null, null];

const similarity = async (a: string, b: string): Promise<number> =>
  Number((await stack.db.one<{ s: number }>("SELECT similarity($1::text, $2::text) AS s", [a, b]))!.s);

/** The context of the last log line with `message`, parsed. */
const lastLogged = (message: string): Record<string, unknown> => {
  const line = [...stack.logs].reverse().find((l) => l.includes(message));
  if (!line) throw new Error(`no "${message}" logged`);
  return JSON.parse(line.slice(line.indexOf(message) + message.length).trim());
};

const users: Record<string, string> = {};
const trees: Record<string, Tree> = {};
const ids: Record<string, string> = {};

describe("the auto-suggestion job", () => {
  beforeAll(async () => {
    const user = async (name: string) => (users[name] = (await createUser(stack, `auto-${name}`)).user_id);

    // Merchant matches, fuzzy and exact, and every row the job must leave alone.
    const merchant = await user("merchant");
    const stranger = await user("stranger");
    trees.merchant = await seedCategoryTree(stack, merchant);
    const coffee = { merchant_name: "Blue Bottle Coffee", amount: "5", account_id: "acc-merchant" };
    ids.history1 = await confirmed(merchant, trees.merchant, coffee);
    await confirmed(merchant, trees.merchant, coffee);
    await confirmed(merchant, trees.merchant, coffee);
    ids.exact = await unlabeled(merchant, coffee);
    ids.fuzzy = await unlabeled(merchant, { ...coffee, merchant_name: "Blue Bottle Coffee #2" });
    ids.dissimilar = await unlabeled(merchant, { ...coffee, merchant_name: "Philz Coffee" });
    ids.old = await unlabeled(merchant, { ...coffee, date: OLD });
    ids.deleted = await unlabeled(merchant, { ...coffee, is_deleted: true });
    ids.suggestedBefore = await unlabeled(merchant, { ...coffee, label_category_id: trees.merchant.category_id, label_category_confidence: 0.6 });
    ids.cleared = await unlabeled(merchant, { ...coffee, label_category_confidence: 0 });
    ids.refund = await unlabeled(merchant, { ...coffee, amount: "-5" });
    ids.zero = await unlabeled(merchant, { ...coffee, amount: "0" });
    // Splits take their features from their parent.
    ids.split = await seedSplit(stack, merchant, { transaction_id: ids.history1, account_id: "acc-merchant", date: RECENT });
    ids.deletedSplit = await seedSplit(stack, merchant, { transaction_id: ids.history1, date: RECENT, is_deleted: true });
    ids.labeledSplit = await seedSplit(stack, merchant, {
      transaction_id: ids.history1,
      date: RECENT,
      label_category_id: trees.merchant.category_id,
      label_category_confidence: 0.5,
    });
    const oldParent = await seedTransaction(stack, merchant, { ...coffee, name: null, date: OLD, label_category_confidence: 0 });
    ids.oldParentSplit = await seedSplit(stack, merchant, { transaction_id: oldParent, date: RECENT });
    const deletedParent = await seedTransaction(stack, merchant, { ...coffee, name: null, label_category_confidence: 0, is_deleted: true });
    ids.deletedParentSplit = await seedSplit(stack, merchant, { transaction_id: deletedParent, date: RECENT });
    const strangersParent = await seedTransaction(stack, stranger, { ...coffee, name: null, label_category_confidence: 0 });
    ids.strangersParentSplit = await seedSplit(stack, merchant, { transaction_id: strangersParent, date: RECENT });

    // Two confirmations are too few.
    const few = await user("few");
    trees.few = await seedCategoryTree(stack, few);
    const market = { merchant_name: "Corner Market", amount: "20", account_id: "acc-few" };
    await confirmed(few, trees.few, market);
    await confirmed(few, trees.few, market);
    ids.few = await unlabeled(few, market);

    // Rejections: exactly a tenth passes, more does not, and a rejection on a deleted transaction does not count.
    for (const [name, rejections] of [
      ["tenth", 1],
      ["rejected", 2],
    ] as [string, number][]) {
      const user_id = await user(name);
      trees[name] = await seedCategoryTree(stack, user_id);
      const grocer = { merchant_name: "Neighborhood Grocer", amount: "40", account_id: `acc-${name}` };
      for (let i = 0; i < 9; i++) await confirmed(user_id, trees[name], grocer);
      for (let i = 0; i < rejections; i++) {
        const rejectedTx = await seedTransaction(stack, user_id, { ...grocer, name: null, date: RECENT, label_category_confidence: 0 });
        await seedRejection(stack, user_id, rejectedTx, trees[name].category_id);
      }
      const deletedRejected = await seedTransaction(stack, user_id, {
        ...grocer,
        name: null,
        date: RECENT,
        label_category_confidence: 0,
        is_deleted: true,
      });
      await seedRejection(stack, user_id, deletedRejected, trees[name].category_id);
      ids[name] = await unlabeled(user_id, grocer);
    }

    // Quality: weak matches alone are too little for a target with a merchant, and enough for one without.
    const quality = await user("quality");
    trees.quality = await seedCategoryTree(stack, quality);
    const food = { personal_finance_category: { primary: "FOOD_AND_DRINK" } };
    const weak = { amount: "12", account_id: "acc-quality", payment_channel: "in store", raw: food };
    for (let i = 0; i < 3; i++) await confirmed(quality, trees.quality, { ...weak, merchant_name: "Totally Different Shop" });
    ids.unseenMerchant = await unlabeled(quality, { ...weak, merchant_name: "Unseen Place" });
    ids.noMerchant = await unlabeled(quality, { ...weak, merchant_name: null, name: null });

    // A quality that clears the minimum but not the floor, and one between the floor and the ceiling.
    const floor = await user("floor");
    trees.floor = await seedCategoryTree(stack, floor);
    trees.floorMiddle = await seedCategoryTree(stack, floor);
    const income = { personal_finance_category: { primary: "INCOME" } };
    for (let i = 0; i < 3; i++) {
      await confirmed(floor, trees.floor, { merchant_name: null, name: "ACME PAYROLL DEPOSIT", amount: "1000", account_id: "acc-floor" });
      await confirmed(floor, trees.floorMiddle, { merchant_name: "Sunrise Bakery", name: null, amount: "8", account_id: "acc-floor" });
    }
    ids.floor = await unlabeled(floor, {
      merchant_name: "Acme Payroll Services",
      name: "ACME PAYROLL DEPOSIT",
      payment_channel: "online",
      raw: income,
      amount: "1000",
      account_id: "acc-floor",
    });
    ids.middle = await unlabeled(floor, {
      merchant_name: "Sunrise Bakery",
      name: "SUNRISE BAKERY 0042",
      payment_channel: "in store",
      raw: food,
      amount: "8",
      account_id: "acc-floor",
    });

    // The identity tier: a merchant's own matches decide, however many weak rows share its category.
    const tier = await user("tier");
    trees.tier = await seedCategoryTree(stack, tier);
    const groceries = { amount: "30", account_id: "acc-tier", payment_channel: "in store", raw: food };
    for (let i = 0; i < 3; i++) await confirmed(tier, trees.tier, { ...groceries, merchant_name: "Trader Joes" });
    for (let i = 0; i < 17; i++) await confirmed(tier, trees.tier, { ...groceries, merchant_name: `Wholesale Depot ${i}` });
    ids.tier = await unlabeled(tier, { ...groceries, merchant_name: "Trader Joes" });

    // The standard tier, when the identity tier's signal fails a gate.
    const fallback = await user("fallback");
    trees.fallback = await seedCategoryTree(stack, fallback);
    const shops = { amount: "50", account_id: "acc-fallback", payment_channel: "in store", raw: { personal_finance_category: { primary: "SHOPS" } } };
    await confirmed(fallback, trees.fallback, { ...shops, merchant_name: "Ferry Building Market" });
    await confirmed(fallback, trees.fallback, { ...shops, merchant_name: "Ferry Building Market" });
    await confirmed(fallback, trees.fallback, { ...shops, merchant_name: "Unrelated Vendor" });
    ids.fallback = await unlabeled(fallback, { ...shops, merchant_name: "Ferry Building Market" });

    // Categories shared through a sharing group: a member's joins, a stranger's does not.
    const shared = await user("shared");
    const member = await user("member");
    await shareData(stack, shared, member);
    trees.member = await seedCategoryTree(stack, member);
    trees.stranger = await seedCategoryTree(stack, stranger);
    const gym = { merchant_name: "City Gym", amount: "70", account_id: "acc-shared" };
    const pharmacy = { merchant_name: "Corner Pharmacy", amount: "15", account_id: "acc-shared" };
    for (let i = 0; i < 3; i++) {
      await confirmed(shared, trees.member, gym);
      await confirmed(shared, trees.stranger, pharmacy);
    }
    ids.sharedCategory = await unlabeled(shared, gym);
    ids.strangersCategory = await unlabeled(shared, pharmacy);
    // History is the user's own: the member has none of their own.
    ids.memberTarget = await unlabeled(member, gym);

    // Competing categories: the highest total wins.
    const competing = await user("competing");
    trees.lesser = await seedCategoryTree(stack, competing);
    trees.greater = await seedCategoryTree(stack, competing);
    for (let i = 0; i < 3; i++) await confirmed(competing, trees.lesser, { merchant_name: "Shell Oil", amount: "40", account_id: "acc-competing" });
    for (let i = 0; i < 4; i++) {
      await confirmed(competing, trees.greater, { merchant_name: "Shell Oil", amount: "60", account_id: "acc-elsewhere", date: OLD });
    }
    ids.competing = await unlabeled(competing, { merchant_name: "Shell Oil", amount: "40", account_id: "acc-competing" });

    // A user whose signal query fails is logged and skipped; the rest still run.
    const failing = await user("failing");
    ids.failing = await unlabeled(failing, { merchant_name: "Anything", raw: { personal_finance_category: { primary: 5 } } });

    await stack.restart();
  }, 120_000);

  test("labels a target from the user's confirmed merchant history, exact or similar, never a dissimilar merchant", async () => {
    expect(await similarity("Blue Bottle Coffee", "Blue Bottle Coffee #2")).toBeGreaterThanOrEqual(0.5);
    expect(await similarity("Blue Bottle Coffee", "Philz Coffee")).toBeLessThan(0.5);
    // Every confirmed row scores 107 of a possible 107: merchant, amount band, account, day.
    expect(await labelOf(ids.exact)).toEqual(suggestion(trees.merchant, 0.98));
    expect(await labelOf(ids.fuzzy)).toEqual(suggestion(trees.merchant, 0.98));
    expect(await labelOf(ids.dissimilar)).toEqual(UNLABELED);
  });

  test("leaves alone what is old, deleted, already suggested or cleared", async () => {
    expect(await labelOf(ids.old)).toEqual(UNLABELED);
    expect(await labelOf(ids.deleted)).toEqual(UNLABELED);
    expect(await labelOf(ids.suggestedBefore)).toEqual([trees.merchant.category_id, null, 0.6]);
    expect(await labelOf(ids.cleared)).toEqual([null, null, 0]);
  });

  test("matches identity features only within the target's sign, and any sign for a zero amount", async () => {
    expect(await labelOf(ids.refund)).toEqual(UNLABELED);
    // Merchant, account and day: 102 of 107.
    expect(await labelOf(ids.zero)).toEqual(suggestion(trees.merchant, 102 / 107));
  });

  test("labels live unlabeled splits of the last week from their parent's features", async () => {
    expect(await splitLabelOf(ids.split)).toEqual(suggestion(trees.merchant, 0.98));
    expect(await splitLabelOf(ids.deletedSplit)).toEqual(UNLABELED);
    expect(await splitLabelOf(ids.labeledSplit)).toEqual([trees.merchant.category_id, null, 0.5]);
    expect(await splitLabelOf(ids.oldParentSplit)).toEqual(UNLABELED);
    expect(await splitLabelOf(ids.deletedParentSplit)).toEqual(UNLABELED);
    expect(await splitLabelOf(ids.strangersParentSplit)).toEqual(UNLABELED);
  });

  test("needs at least three matching confirmations", async () => {
    expect(await labelOf(ids.few)).toEqual(UNLABELED);
  });

  test("allows rejections up to a tenth of the weighted total, not counting deleted transactions", async () => {
    expect(await labelOf(ids.tenth)).toEqual(suggestion(trees.tenth, 0.98));
    expect(await labelOf(ids.rejected)).toEqual(UNLABELED);
  });

  test("needs an average match of at least 0.30 of the target's possible score", async () => {
    // 18 of 118 per row: the weak features alone, for a target with a merchant.
    expect(await labelOf(ids.unseenMerchant)).toEqual(UNLABELED);
    // 18 of 18: the PFC fallback for a target with no merchant or name.
    expect(await labelOf(ids.noMerchant)).toEqual(suggestion(trees.quality, 0.98));
  });

  test("stores the quality as the confidence, raised to 0.5 and capped at 0.98", async () => {
    // Name, amount, account, day: 57 of 168.
    expect(await labelOf(ids.floor)).toEqual(suggestion(trees.floor, 0.5));
    // Merchant, amount, account, day: 107 of 168.
    expect(await labelOf(ids.middle)).toEqual(suggestion(trees.floorMiddle, 107 / 168));
  });

  test("judges a merchant with confirmed history on its identity matches first, and falls back to every match when they fail a gate", async () => {
    expect(await similarity("Trader Joes", "Wholesale Depot 1")).toBeLessThan(0.5);
    expect(await labelOf(ids.tier)).toEqual(suggestion(trees.tier, 0.98));
    // Two identity matches are too few; with the weak one, 254 of 3 × 118.
    expect(await labelOf(ids.fallback)).toEqual(suggestion(trees.fallback, 254 / 354));
  });

  test("labels with a category of the sharing group, never a stranger's, from the user's own history only", async () => {
    expect(await labelOf(ids.sharedCategory)).toEqual(suggestion(trees.member, 0.98));
    expect(await labelOf(ids.strangersCategory)).toEqual(UNLABELED);
    expect(await labelOf(ids.memberTarget)).toEqual(UNLABELED);
  });

  test("picks the category with the highest total score", async () => {
    // Four merchant-only matches (400) beat three full ones (321): 400 of 4 × 107.
    expect(await labelOf(ids.competing)).toEqual(suggestion(trees.greater, 400 / 428));
  });

  test("logs what it did for each user and in total, skipping a user whose query fails", async () => {
    expect(await labelOf(ids.failing)).toEqual(UNLABELED);
    await stack.waitForLog(`Auto-suggestion failed for user {"userId":"${users.failing}"}`);
    const { n } = (await stack.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE is_deleted IS NOT TRUE"))!;
    expect(lastLogged("Auto-suggestion job completed")).toEqual({ usersProcessed: n - 1, transactionsSuggested: 12 });
    const perUser: [string, number][] = [
      ["merchant", 4],
      ["tenth", 1],
      ["quality", 1],
      ["floor", 2],
      ["tier", 1],
      ["fallback", 1],
      ["shared", 1],
      ["competing", 1],
    ];
    for (const [name, suggested] of perUser) {
      expect(stack.logCount(`Auto-suggested categories for user {"userId":"${users[name]}","suggested":${suggested}}`)).toBe(1);
    }
    for (const name of ["few", "rejected", "member", "stranger", "failing"]) {
      expect(stack.logCount(`Auto-suggested categories for user {"userId":"${users[name]}"`)).toBe(0);
    }
  });

  test("lists what it stored through the API, to each user and their sharing group", async () => {
    const storedOf = async (table: string, group: string[]) =>
      (
        await stack.db.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.user_id IN (${group.map((_, i) => `$${i + 1}`).join(", ")})`,
          group,
        )
      ).map(({ row }) => row);
    const byKey = (key: string) => (a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a[key]).localeCompare(String(b[key]));
    for (const name of ["merchant", "tenth", "quality", "floor", "tier", "fallback", "shared", "member", "competing"]) {
      const client = await stack.login(`auto-${name}`, `auto-${name}-password`);
      const group = name === "shared" || name === "member" ? [users.shared, users.member] : [users[name]];
      const listed = await client.get<{ transactions: Record<string, unknown>[] }>("/transactions");
      const transactions = (await storedOf("transactions", group)).map(transactionJson);
      expect([name, [...listed.body.transactions].sort(byKey("transaction_id"))]).toEqual([
        name,
        transactions.sort(byKey("transaction_id")),
      ]);
      const splits = await client.get<Record<string, unknown>[]>("/split-transactions");
      expect([name, [...splits.body].sort(byKey("split_transaction_id"))]).toEqual([
        name,
        (await storedOf("split_transactions", group)).map(splitJson).sort(byKey("split_transaction_id")),
      ]);
    }
  });

  test("suggests nothing again on the next run: a suggested row is no longer unlabeled", async () => {
    const before = await stack.db.query("SELECT transaction_id, label_category_id, label_budget_id, label_category_confidence FROM transactions ORDER BY transaction_id");
    const splitsBefore = await stack.db.query(
      "SELECT split_transaction_id, label_category_id, label_category_confidence FROM split_transactions ORDER BY split_transaction_id",
    );
    await stack.restart();
    const { n } = (await stack.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE is_deleted IS NOT TRUE"))!;
    expect(lastLogged("Auto-suggestion job completed")).toEqual({ usersProcessed: n - 1, transactionsSuggested: 0 });
    expect(
      await stack.db.query("SELECT transaction_id, label_category_id, label_budget_id, label_category_confidence FROM transactions ORDER BY transaction_id"),
    ).toEqual(before);
    expect(
      await stack.db.query("SELECT split_transaction_id, label_category_id, label_category_confidence FROM split_transactions ORDER BY split_transaction_id"),
    ).toEqual(splitsBefore);
  }, 120_000);
});
