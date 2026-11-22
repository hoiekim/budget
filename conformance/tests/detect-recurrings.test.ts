/**
 * The recurring-detection job every server start runs (and the hourly sync
 * after it): per user, it suggests a recurring for a merchant's regular,
 * similar, recent settled charges, reconciles what it finds with the stored
 * recurrings, and lets confirmed recurrings collect their new charges, which
 * take the recurring's default label and splits. It has no route: a test
 * starts a server, seeds what the job should find, restarts the server and
 * reads what the job stored and logged.
 *
 * Dates count from today's UTC date, the "today" the detector measures lapses
 * from; intervals are calendar days, so the time zone does not change them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createUser, startStack, type ApiClient, type Stack } from "../harness";
import { seedBudget, seedCategory, seedSection } from "../harness/seed/budgets";
import {
  loggedContexts,
  loggedCounts,
  pick,
  seedAccount,
  seedPair,
  seedRecurring,
  seedTransaction,
  shareData,
  stored,
  storedLabels,
  storedSplits,
  utcDay,
  withWritesFailing,
  type SeedTransaction,
} from "../harness/seed/transfers";

const stacks: Stack[] = [];
afterAll(async () => {
  await Promise.all(stacks.map((stack) => stack.stop()));
});

const start = async (): Promise<Stack> => {
  const stack = await startStack();
  stacks.push(stack);
  return stack;
};

/** How many users a run covers: every live one, the boot-time `admin` and `demo` included. */
const liveUsers = async (stack: Stack): Promise<number> =>
  Number((await stack.db.one<{ n: string }>("SELECT count(*)::text AS n FROM users WHERE is_deleted IS NOT TRUE"))!.n);

/** Restarts the server and answers where its log lines start. */
const runDetection = async (stack: Stack): Promise<number> => {
  const from = stack.logs.length;
  await stack.restart();
  return from;
};

interface Owner {
  id: string;
  login: () => Promise<ApiClient>;
  /**
   * Charges of one merchant, one per entry of `days` (days from today's UTC
   * date, oldest first), with ids `<user>-<slug>-<i>`; their ids are returned.
   */
  charges: (
    slug: string,
    merchant: string | null,
    amount: number | null,
    days: number[],
    extra?: (i: number) => Partial<SeedTransaction>,
  ) => Promise<string[]>;
}

const owner = async (stack: Stack, name: string): Promise<Owner> => {
  const { user_id, password } = await createUser(stack, name);
  await seedAccount(stack, user_id, `${name}-chk`);
  await seedAccount(stack, user_id, `${name}-sav`);
  await seedAccount(stack, user_id, `${name}-hidden`, { hide: true });
  return {
    id: user_id,
    login: () => stack.login(name, password),
    charges: async (slug, merchant, amount, days, extra = () => ({})) => {
      const ids: string[] = [];
      for (const [i, day] of days.entries()) {
        const tx = await seedTransaction(stack, user_id, {
          transaction_id: `${name}-${slug}-${i}`,
          account_id: `${name}-chk`,
          amount,
          date: utcDay(day),
          merchant_name: merchant,
          name: merchant === null ? null : `${merchant} purchase`,
          ...extra(i),
        });
        ids.push(tx.transaction_id);
      }
      return ids;
    },
  };
};

const ROW_COLUMNS = ["merchant_key", "merchant_name", "cadence", "is_income", "status", "transaction_ids", "is_deleted"];
const recurringsOf = async (stack: Stack, user_id: string, columns = ROW_COLUMNS) =>
  (await stored(stack, "recurrings", { user_id }, "t.merchant_key, t.is_income")).map((row) => pick(row, columns));

const row = (merchant_key: string, merchant_name: string, cadence: string, transaction_ids: string[], extra: Record<string, unknown> = {}) => ({
  merchant_key,
  merchant_name,
  cadence,
  is_income: false,
  status: "suggested",
  transaction_ids,
  is_deleted: false,
  ...extra,
});

/** A budget and a category in it, both the user's. */
const label = async (stack: Stack, user_id: string) => {
  const budget_id = await seedBudget(stack, user_id);
  return { budget_id, category_id: await seedCategory(stack, user_id, await seedSection(stack, user_id, budget_id)) };
};

describe("recurring detection", () => {
  test("suggests each cadence, income apart from expenses, keyed on the merchant and named by its most common name", async () => {
    const stack = await start();
    const alice = await owner(stack, "alice");
    const gym = await alice.charges("gym", "Gym", 25, [-24, -17, -10, -3]);
    const pay = await alice.charges("pay", "Payroll", -2000, [-47, -33, -19, -5]);
    const netflixNames = ["Netflix 8665795717", "NETFLIX.COM", "Netflix", "NETFLIX.COM"];
    const netflix = await alice.charges("netflix", null, 15.99, [-99, -69, -38, -8], (i) => ({ merchant_name: netflixNames[i] }));
    const insurance = await alice.charges("insurance", "Insurance", 300, [-202, -111, -20]);
    const registration = await alice.charges("car", "Car Reg", 150, [-396, -213, -30]);
    const domain = await alice.charges("domain", "Domain", 12, [-770, -405, -40]);
    const buys = await alice.charges("buy", "Marketplace", 30, [-72, -42, -12]);
    const sales = await alice.charges("sale", "Marketplace", -50, [-75, -45, -15]);
    const posted = await alice.charges("posted", null, 9, [-91, -61, -31, -1], (i) => ({ name: `Manual DB-Bkrg ${String(i + 1).padStart(2, "0")}/03` }));
    // A fee billed beside the rent is its own amount cluster, and the larger amount wins.
    const rent = await alice.charges("rent", "Housing", 3900, [-95, -65, -35, -5]);
    await alice.charges("fee", "Housing", 2.49, [-95, -65, -35, -5]);

    const from = await runDetection(stack);
    const expected = [
      row("car reg", "Car Reg", "semiannual", registration),
      row("domain", "Domain", "annual", domain),
      row("gym", "Gym", "weekly", gym),
      row("housing", "Housing", "monthly", rent),
      row("insurance", "Insurance", "quarterly", insurance),
      row("manual db bkrg", "Manual DB-Bkrg 01/03", "monthly", posted),
      row("marketplace", "Marketplace", "monthly", buys),
      row("marketplace", "Marketplace", "monthly", sales, { is_income: true }),
      row("netflix", "NETFLIX.COM", "monthly", netflix),
      row("payroll", "Payroll", "biweekly", pay, { is_income: true }),
    ];
    expect(await recurringsOf(stack, alice.id)).toEqual(expected);
    expect(loggedContexts(stack, "Updated recurrings for user", from)).toEqual([{ userId: alice.id, suggested: 10, attached: 0, groupsDetected: 10 }]);
    expect(loggedCounts(stack, "Recurring-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), recurringsSuggested: 10, chargesAttached: 0 });
    const listed = await (await alice.login()).get<{ merchant_key: string; status: string; transactions: unknown[] }[]>("/recurrings");
    expect(listed.body.map((r) => [r.merchant_key, r.status, r.transactions.length]).sort()).toEqual(
      expected.map((r) => [r.merchant_key, r.status, r.transaction_ids.length]).sort(),
    );

    // Run again, nothing changed: no write, not even to `updated`.
    const before = await recurringsOf(stack, alice.id, ["recurring_id", "updated"]);
    const again = await runDetection(stack);
    expect(loggedContexts(stack, "Updated recurrings for user", again)).toEqual([]);
    expect(loggedCounts(stack, "Recurring-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), recurringsSuggested: 0, chargesAttached: 0 });
    expect(await recurringsOf(stack, alice.id, ["recurring_id", "updated"])).toEqual(before);
  });

  test("needs three regular, similar, recent, settled charges of one user, and four after earlier ones", async () => {
    const stack = await start();
    const bob = await owner(stack, "bob");
    const erin = await owner(stack, "erin");
    await shareData(stack, bob.id, erin.id);
    // None of these recur.
    await bob.charges("two", "Two Only", 10, [-40, -10]);
    await bob.charges("irregular", "Irregular", 10, [-60, -50, -20, -5]);
    await bob.charges("varying", "Varying", 10, [-100, -70, -40, -10], (i) => ({ amount: [50, 70, 36, 60][i] }));
    await bob.charges("lapsed", "Lapsed Weekly", 9, [-36, -29, -22, -15]);
    await bob.charges("late", "Monthly Late", 9, [-122, -92, -61]);
    await bob.charges("loose", "Too Loose", 9, [-31, -21, -11, -1]);
    await bob.charges("pending", "Pending Co", 10, [-70, -40, -10], (i) => ({ pending: i === 1 }));
    await bob.charges("hidden", "Hidden Co", 10, [-70, -40, -10], () => ({ account_id: "bob-hidden" }));
    await bob.charges("deleted", "Deleted Co", 10, [-70, -40, -10], (i) => ({ is_deleted: i === 2 }));
    await bob.charges("zero", "Zero Co", 10, [-70, -40, -10], (i) => ({ amount: i === 0 ? 0 : 10 }));
    await bob.charges("nameless", null, 10, [-70, -40, -10], () => ({ name: "###" }));
    await bob.charges("cafe-early", "Corner Cafe", 20, [-250, -233, -190]);
    await bob.charges("cafe", "Corner Cafe", 20, [-70, -40, -10]);
    await bob.charges("shop-early", "Corner Shop", 20, [-250, -233, -190]);
    await bob.charges("shop", "Corner Shop", 20, [-70, -40, -10]);
    const out = await bob.charges("transfer", "Transfer Co", 100, [-70, -40, -10]);
    const into = await bob.charges("savings", "Savings In", -100, [-70, -40, -10], () => ({ account_id: "bob-sav" }));
    for (const [i, id] of out.entries()) await seedPair(stack, bob.id, id, into[i], { status: "confirmed" });
    // Detection is per user, even within a sharing group.
    await bob.charges("shared", "Shared Sub", 8, [-40, -10]);
    await erin.charges("shared", "Shared Sub", 8, [-70]);
    // These do.
    const weeklyEdge = await bob.charges("weekly-edge", "Weekly Edge", 9, [-35, -28, -21, -14]);
    const monthlyEdge = await bob.charges("monthly-edge", "Monthly Edge", 9, [-121, -91, -60]);
    const tolerance = await bob.charges("tolerance", "Tolerance", 9, [-28, -19, -10]);
    const within = await bob.charges("within", "Within Quarter", 10, [-100, -70, -40, -10], (i) => ({ amount: [50, 55, 48, 60][i] }));
    const pending = await bob.charges("suggested", "Suggested Transfer", 200, [-70, -40, -10]);
    const pendingInto = await bob.charges("savings-two", "Savings Two", -200, [-70, -40, -10], () => ({ account_id: "bob-sav" }));
    for (const [i, id] of pending.entries()) await seedPair(stack, bob.id, id, pendingInto[i]);
    const shopRun = await bob.charges("shop-run", "Corner Shop", 20, [-100]);

    const from = await runDetection(stack);
    const expected = [
      row("corner shop", "Corner Shop", "monthly", [shopRun[0], `bob-shop-0`, `bob-shop-1`, `bob-shop-2`]),
      row("monthly edge", "Monthly Edge", "monthly", monthlyEdge),
      row("savings two", "Savings Two", "monthly", pendingInto, { is_income: true }),
      row("suggested transfer", "Suggested Transfer", "monthly", pending),
      row("tolerance", "Tolerance", "weekly", tolerance),
      row("weekly edge", "Weekly Edge", "weekly", weeklyEdge),
      row("within quarter", "Within Quarter", "monthly", within),
    ];
    expect(await recurringsOf(stack, bob.id)).toEqual(expected);
    expect(await recurringsOf(stack, erin.id)).toEqual([]);
    expect(loggedContexts(stack, "Updated recurrings for user", from)).toEqual([{ userId: bob.id, suggested: 7, attached: 0, groupsDetected: 7 }]);
    expect(loggedCounts(stack, "Recurring-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), recurringsSuggested: 7, chargesAttached: 0 });
  });

  test("reconciles with stored recurrings: skips dismissed, refreshes suggested, revives deleted, cleans ghosts", async () => {
    const stack = await start();
    const carol = await owner(stack, "carol");
    const four = [-100, -70, -40, -10];
    const three = [-70, -40, -10];
    const old = "2020-01-01T00:00:00Z";
    const l = await label(stack, carol.id);
    const dismissedCharges = await carol.charges("dc", "Dismissed Co", 10, four);
    const suggestedCharges = await carol.charges("sc", "Suggested Co", 11, four);
    const sameCharges = await carol.charges("same", "Same Co", 12, three);
    const shared = await carol.charges("sh", "Shared Charge", 13, four);
    const tooHeld = await carol.charges("th", "Too Held", 14, three);
    const refreshHeld = await carol.charges("rh", "Refresh Held", 15, four);
    const revivedSuggested = await carol.charges("rs", "Revived Suggested", 16, three);
    const revivedConfirmed = await carol.charges("rc", "Revived Confirmed", 20, three, (i) => ({ label_category_confidence: i === 0 ? 0.5 : null }));
    const revivedDismissed = await carol.charges("rd", "Revived Dismissed", 17, three);
    const confirmedFew = await carol.charges("cf", "Confirmed Few", 18, four);
    const suggestedFew = await carol.charges("sf", "Suggested Few", 19, four);
    const ghost = await carol.charges("ghost", "Ghost", 21, [-10], () => ({ is_deleted: true }));

    const ids: Record<string, string> = {};
    ids.dismissed = await seedRecurring(stack, carol.id, { merchant_key: "dismissed co", merchant_name: "Dismissed Co", status: "dismissed", transaction_ids: [dismissedCharges[0]], updated: old });
    ids.suggested = await seedRecurring(stack, carol.id, { merchant_key: "suggested co", merchant_name: "Custom name", cadence: "weekly", transaction_ids: suggestedCharges.slice(0, 3), updated: old });
    ids.same = await seedRecurring(stack, carol.id, { merchant_key: "same co", merchant_name: "Same Co", transaction_ids: [sameCharges[2], sameCharges[0], sameCharges[1]], updated: old });
    const held = [shared[3], tooHeld[2], refreshHeld[3], confirmedFew[2], confirmedFew[3], suggestedFew[2], suggestedFew[3]];
    ids.holder = await seedRecurring(stack, carol.id, { merchant_key: "holder", merchant_name: "Holder", status: "confirmed", transaction_ids: held });
    ids.refresh = await seedRecurring(stack, carol.id, { merchant_key: "refresh held", merchant_name: "Refresh Held", transaction_ids: refreshHeld.slice(0, 3), updated: old });
    ids.revivedSuggested = await seedRecurring(stack, carol.id, { merchant_key: "revived suggested", merchant_name: "Old name", cadence: "weekly", is_deleted: true, transaction_ids: ["carol-gone-1"] });
    ids.revivedConfirmed = await seedRecurring(stack, carol.id, {
      merchant_key: "revived confirmed",
      merchant_name: "Revived Confirmed",
      status: "confirmed",
      is_deleted: true,
      label_budget_id: l.budget_id,
      label_category_id: l.category_id,
      splits: [{ amount: 5, label: { budget_id: l.budget_id, category_id: null } }],
      splits_since: utcDay(-40),
    });
    ids.revivedDismissed = await seedRecurring(stack, carol.id, { merchant_key: "revived dismissed", merchant_name: "Revived Dismissed", status: "dismissed", is_deleted: true });
    ids.confirmedFew = await seedRecurring(stack, carol.id, { merchant_key: "confirmed few", merchant_name: "Confirmed Few", status: "confirmed", is_deleted: true });
    ids.suggestedFew = await seedRecurring(stack, carol.id, { merchant_key: "suggested few", merchant_name: "Suggested Few", is_deleted: true });
    ids.ghost = await seedRecurring(stack, carol.id, { merchant_key: "ghost", merchant_name: "Ghost", transaction_ids: ghost });

    const from = await runDetection(stack);
    expect(await recurringsOf(stack, carol.id)).toEqual([
      row("confirmed few", "Confirmed Few", "monthly", confirmedFew.slice(0, 2), { status: "confirmed" }),
      row("dismissed co", "Dismissed Co", "monthly", [dismissedCharges[0]], { status: "dismissed" }),
      row("ghost", "Ghost", "monthly", ghost, { is_deleted: true }),
      row("holder", "Holder", "monthly", held, { status: "confirmed" }),
      row("refresh held", "Refresh Held", "monthly", refreshHeld.slice(0, 3)),
      row("revived confirmed", "Revived Confirmed", "monthly", revivedConfirmed, { status: "confirmed" }),
      row("revived dismissed", "Revived Dismissed", "monthly", revivedDismissed, { status: "dismissed" }),
      row("revived suggested", "Old name", "monthly", revivedSuggested),
      row("same co", "Same Co", "monthly", [sameCharges[2], sameCharges[0], sameCharges[1]]),
      row("shared charge", "Shared Charge", "monthly", shared.slice(0, 3)),
      row("suggested co", "Custom name", "monthly", suggestedCharges),
      row("suggested few", "Suggested Few", "monthly", [], { is_deleted: true }),
    ]);
    // Only the refreshed suggestion and the revived rows were written.
    const updated = Object.fromEntries((await stored(stack, "recurrings", { user_id: carol.id })).map((r) => [r.recurring_id, String(r.updated)]));
    for (const untouched of [ids.dismissed, ids.same, ids.refresh]) expect(updated[untouched]).toStartWith("2020-01-01");
    expect(updated[ids.suggested]).not.toStartWith("2020-01-01");
    // The revived confirmed recurring labels its charges, and splits those from its splits date on.
    const after = (id: string) => ({ transaction_id: id, label_budget_id: l.budget_id, label_category_id: l.category_id, label_category_confidence: 1 });
    expect(await storedLabels(stack, revivedConfirmed)).toEqual(revivedConfirmed.map(after));
    expect(await storedSplits(stack, revivedConfirmed)).toEqual(
      revivedConfirmed.slice(1).map((id, i) => ({
        transaction_id: id,
        account_id: "carol-chk",
        amount: 5,
        date: utcDay(three[i + 1]),
        label_budget_id: l.budget_id,
        label_category_id: null,
        label_category_confidence: 0,
      })),
    );
    expect(await storedLabels(stack, confirmedFew)).toEqual(
      confirmedFew.map((id) => ({ transaction_id: id, label_budget_id: null, label_category_id: null, label_category_confidence: null })),
    );
    expect(loggedContexts(stack, "Cleaned stale recurrings", from)).toEqual([{ userId: carol.id, count: 1 }]);
    expect(loggedContexts(stack, "Updated recurrings for user", from)).toEqual([{ userId: carol.id, suggested: 2, attached: 5, groupsDetected: 11 }]);
    expect(loggedCounts(stack, "Recurring-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), recurringsSuggested: 2, chargesAttached: 5 });
    // Listed: the live ones neither dismissed nor without a live member.
    expect((await (await carol.login()).get<unknown[]>("/recurrings")).body).toHaveLength(8);
  });

  test("confirmed recurrings collect their new charges, which take the default label and splits", async () => {
    const stack = await start();
    const dave = await owner(stack, "dave");
    const [l, spotifyLabel] = [await label(stack, dave.id), await label(stack, dave.id)];
    // A late charge joins on the schedule; a refund and a charge held elsewhere do not.
    const netflix = await dave.charges("netflix", "Netflix", 15.99, [-130, -100, -70, -28, -10]);
    await dave.charges("refund", "Netflix", -15.99, [-27]);
    const netflixId = await seedRecurring(stack, dave.id, {
      merchant_key: "netflix",
      merchant_name: "Netflix",
      status: "confirmed",
      transaction_ids: netflix.slice(0, 3),
      label_budget_id: l.budget_id,
      label_category_id: l.category_id,
      splits: [{ amount: 3, label: { budget_id: l.budget_id, category_id: null } }],
      splits_since: utcDay(-60),
    });
    await seedRecurring(stack, dave.id, { merchant_key: "other holder", merchant_name: "Other Holder", transaction_ids: [netflix[4]] });
    // A charge enrichment renamed joins by its bank description, unless its own name is another recurring's.
    const bakery = await dave.charges("bakery", "Corner Bakery", 12, [-24, -17, -10, -3], (i) =>
      i === 3 ? { merchant_name: "Bakery Holdings Inc.", name: "POS CORNER BAKERY ANYTOWN 0412" } : { name: "POS CORNER BAKERY ANYTOWN" },
    );
    const bakeryId = await seedRecurring(stack, dave.id, { merchant_key: "corner bakery", merchant_name: "Corner Bakery", cadence: "weekly", status: "confirmed", transaction_ids: bakery.slice(0, 3) });
    const oldBakery = await dave.charges("old", "Old Bakery", 7, [-24, -17, -10, -3], (i) =>
      i === 3 ? { merchant_name: "New Owner LLC", name: "POS OLD BAKERY 0412" } : { name: "POS OLD BAKERY" },
    );
    const newOwner = await dave.charges("owner", "New Owner LLC", 40, [-50]);
    const oldBakeryId = await seedRecurring(stack, dave.id, { merchant_key: "old bakery", merchant_name: "Old Bakery", cadence: "weekly", status: "confirmed", transaction_ids: oldBakery.slice(0, 3) });
    await seedRecurring(stack, dave.id, { merchant_key: "new owner llc", merchant_name: "New Owner LLC", transaction_ids: newOwner });
    // One member: the next charge one period of any cadence later joins.
    const gym = await dave.charges("gym", "Gym", 25, [-8, -1]);
    const gymId = await seedRecurring(stack, dave.id, { merchant_key: "gym", merchant_name: "Gym", status: "confirmed", transaction_ids: [gym[0]] });
    // A qualifying run holding a member brings in the merchant's earlier charges.
    const spotify = await dave.charges("spotify", "Spotify", 9.99, [-95, -65, -35, -5]);
    const spotifyId = await seedRecurring(stack, dave.id, {
      merchant_key: "spotify",
      merchant_name: "Spotify",
      status: "confirmed",
      transaction_ids: [spotify[3]],
      label_budget_id: spotifyLabel.budget_id,
      label_category_id: spotifyLabel.category_id,
    });

    const from = await runDetection(stack);
    const members = async (id: string) => (await stored(stack, "recurrings", { recurring_id: id }))[0].transaction_ids;
    expect(await members(netflixId)).toEqual(netflix.slice(0, 4));
    expect(await members(bakeryId)).toEqual(bakery);
    expect(await members(oldBakeryId)).toEqual(oldBakery.slice(0, 3));
    expect(await members(gymId)).toEqual(gym);
    expect(await members(spotifyId)).toEqual([spotify[3], ...spotify.slice(0, 3)]);

    const none = { label_budget_id: null, label_category_id: null, label_category_confidence: null };
    expect(await storedLabels(stack, netflix)).toEqual(
      netflix.map((id, i) => ({ transaction_id: id, ...(i === 3 ? { label_budget_id: l.budget_id, label_category_id: l.category_id, label_category_confidence: 1 } : none) })),
    );
    expect(await storedSplits(stack, netflix)).toEqual([
      { transaction_id: netflix[3], account_id: "dave-chk", amount: 3, date: utcDay(-28), label_budget_id: l.budget_id, label_category_id: null, label_category_confidence: 0 },
    ]);
    expect(await storedLabels(stack, spotify)).toEqual(
      spotify.map((id, i) => ({
        transaction_id: id,
        ...(i < 3 ? { label_budget_id: spotifyLabel.budget_id, label_category_id: spotifyLabel.category_id, label_category_confidence: 1 } : none),
      })),
    );
    expect(await storedLabels(stack, bakery)).toEqual(bakery.map((id) => ({ transaction_id: id, ...none })));
    expect(loggedContexts(stack, "Updated recurrings for user", from)).toEqual([{ userId: dave.id, suggested: 0, attached: 6, groupsDetected: 3 }]);
    expect(loggedCounts(stack, "Recurring-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), recurringsSuggested: 0, chargesAttached: 6 });
    const listed = await (await dave.login()).get<{ merchant_key: string; transactions: unknown[] }[]>("/recurrings");
    expect(listed.body.map((r) => [r.merchant_key, r.transactions.length]).sort()).toEqual([
      ["corner bakery", 4],
      ["gym", 2],
      ["netflix", 4],
      ["new owner llc", 1],
      ["old bakery", 3],
      ["other holder", 1],
      ["spotify", 4],
    ]);
  });

  test("a user whose run fails is rolled back and left out of the count, and the others carry on", async () => {
    const stack = await start();
    const victim = await owner(stack, "victim");
    const fine = await owner(stack, "fine");
    const ghost = await victim.charges("ghost", "Ghost", 5, [-10], () => ({ is_deleted: true }));
    await seedRecurring(stack, victim.id, { merchant_key: "ghost", transaction_ids: ghost });
    await victim.charges("bill", "Bill", 30, [-70, -40, -10]);
    const bill = await fine.charges("bill", "Bill", 30, [-70, -40, -10]);

    const from = await withWritesFailing(stack, "recurrings", "UPDATE", `OLD.user_id = '${victim.id}'`, () => runDetection(stack));
    expect(loggedContexts(stack, "Recurring detection failed for user", from)).toEqual([{ userId: victim.id }]);
    expect(await recurringsOf(stack, victim.id)).toEqual([row("ghost", "Seeded Merchant", "monthly", ghost)]);
    expect(await recurringsOf(stack, fine.id)).toEqual([row("bill", "Bill", "monthly", bill)]);
    expect(loggedCounts(stack, "Recurring-detection job completed")).toEqual({ usersProcessed: (await liveUsers(stack)) - 1, recurringsSuggested: 1, chargesAttached: 0 });
  });
});
