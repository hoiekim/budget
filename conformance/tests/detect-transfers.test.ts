/**
 * The transfer-detection job every server start runs (and the hourly sync
 * after it): it suggests a pair for two transactions of opposite amounts on
 * two accounts within `TRANSFER_DATE_WINDOW_DAYS`, per user, or per sharing
 * group. It has no route: a test starts a server, seeds what the job should
 * find, restarts the server and reads what the job stored and logged.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createUser, startStack, type ApiClient, type Stack } from "../harness";
import {
  loggedContexts,
  loggedCounts,
  localDay,
  seedAccount,
  seedPair,
  seedTransaction,
  shareData,
  stored,
  withWritesFailing,
  type SeedTransaction,
} from "../harness/seed/transfers";

/** `TRANSFER_DATE_WINDOW_DAYS`. */
const WINDOW = 7;

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

/** Restarts the server and answers the log lines its run wrote. */
const runDetection = async (stack: Stack): Promise<number> => {
  const from = stack.logs.length;
  await stack.restart();
  return from;
};

interface Owner {
  id: string;
  /** Signs in as this user. */
  login: () => Promise<ApiClient>;
  /** A transaction of this user: `<prefix><suffix>` on account `<prefix><account>`. */
  tx: (suffix: string, account: string, amount: number | null, days: number, extra?: Partial<SeedTransaction>) => Promise<string>;
}

const owner = async (stack: Stack, name: string, accounts: string[], hidden: string[] = []): Promise<Owner> => {
  const { user_id, password } = await createUser(stack, name);
  for (const account of accounts) await seedAccount(stack, user_id, `${name}-${account}`);
  for (const account of hidden) await seedAccount(stack, user_id, `${name}-${account}`, { hide: true });
  return {
    id: user_id,
    login: () => stack.login(name, password),
    tx: async (suffix, account, amount, days, extra = {}) =>
      (
        await seedTransaction(stack, user_id, {
          transaction_id: `${name}-${suffix}`,
          account_id: `${name}-${account}`,
          amount,
          date: localDay(days),
          ...extra,
        })
      ).transaction_id,
  };
};

/** Every pair whose transactions start with `prefix`, as stored, in canonical order. */
const pairsAmong = async (stack: Stack, prefix: string) =>
  (await stored(stack, "transaction_pairs", {}, "t.transaction_id_a, t.transaction_id_b"))
    .filter((row) => String(row.transaction_id_a).startsWith(prefix) || String(row.transaction_id_b).startsWith(prefix))
    .map((row) => ({
      user_id: row.user_id,
      transaction_id_a: row.transaction_id_a,
      transaction_id_b: row.transaction_id_b,
      status: row.status,
      is_deleted: row.is_deleted,
    }));

const suggested = (user_id: string, a: string, b: string) => ({ user_id, transaction_id_a: a, transaction_id_b: b, status: "suggested", is_deleted: false });

describe("transfer detection", () => {
  test("suggests opposite amounts on two visible accounts within the window, pending or not, and nothing else", async () => {
    const stack = await start();
    const alice = await owner(stack, "alice", ["chk", "sav"], ["hidden"]);
    const bob = await owner(stack, "bob", ["acc"]);
    const ids: Record<string, string> = {};
    const add = async (key: string, account: string, amount: number | null, days: number, extra: Partial<SeedTransaction> = {}) => {
      ids[key] = await alice.tx(key, account, amount, days, extra);
    };
    // Paired: same day; at the window's edge; pending; tagged by Plaid as a transfer.
    await add("p1-out", "chk", 100, -20);
    await add("p1-in", "sav", -100, -20);
    await add("p2-out", "chk", 200, -30);
    await add("p2-in", "sav", -200, -30 + WINDOW);
    await add("p3-out", "chk", 300.5, -40, { pending: true });
    await add("p3-in", "sav", -300.5, -41, { pending: true });
    await add("p4-out", "chk", 400, -50, { raw: { personal_finance_category: { primary: "TRANSFER_OUT" } } });
    await add("p4-in", "sav", -400, -52);
    // Not paired: a day past the window; one account; a cent apart; one sign; zero; no amount; a hidden account;
    // a deleted side; an account of someone else's; an account that does not exist.
    await add("n1-out", "chk", 500, -60);
    await add("n1-in", "sav", -500, -60 + WINDOW + 1);
    await add("n2-out", "chk", 600, -70);
    await add("n2-in", "chk", -600, -70);
    await add("n3-out", "chk", 700, -80);
    await add("n3-in", "sav", -700.01, -80);
    await add("n4-out", "chk", 800, -90);
    await add("n4-in", "sav", 800, -90);
    await add("n5-out", "chk", 0, -100);
    await add("n5-in", "sav", 0, -100);
    await add("n6-out", "chk", null, -105);
    await add("n6-in", "sav", null, -105);
    await add("n7-out", "chk", 900, -110);
    await add("n7-in", "hidden", -900, -110);
    await add("n8-out", "chk", 1000, -120, { is_deleted: true });
    await add("n8-in", "sav", -1000, -120);
    await seedTransaction(stack, alice.id, { transaction_id: "alice-n9-out", account_id: "bob-acc", amount: 1100, date: localDay(-130) });
    await add("n9-in", "sav", -1100, -130);
    await seedTransaction(stack, alice.id, { transaction_id: "alice-n10-out", account_id: "nowhere", amount: 1200, date: localDay(-140) });
    await add("n10-in", "sav", -1200, -140);
    // Bob's own transaction on his account pairs with nothing of Alice's.
    await bob.tx("in", "acc", -100, -20);

    const from = await runDetection(stack);
    expect(await pairsAmong(stack, "alice-")).toEqual([
      suggested(alice.id, ids["p1-in"], ids["p1-out"]),
      suggested(alice.id, ids["p2-in"], ids["p2-out"]),
      suggested(alice.id, ids["p3-in"], ids["p3-out"]),
      suggested(alice.id, ids["p4-in"], ids["p4-out"]),
    ]);
    expect(await pairsAmong(stack, "bob-")).toEqual([]);
    expect(loggedContexts(stack, "Suggested transfer pairs for user", from)).toEqual([
      { userId: alice.id, members: 1, suggested: 4, candidatesConsidered: 4 },
    ]);
    expect(loggedCounts(stack, "Transfer-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), pairsSuggested: 4 });
    const listed = await (await alice.login()).get<{ status: string; transactions: { transaction_id: string }[] }[]>("/transfers");
    // Pairs list in pair id order, which is random: compare them sorted.
    expect(listed.body.map((pair) => [pair.status, ...pair.transactions.map((t) => t.transaction_id)]).sort()).toEqual(
      ["p1", "p2", "p3", "p4"].map((p) => ["suggested", ids[`${p}-in`], ids[`${p}-out`]]),
    );

    // The next run finds them paired and suggests nothing.
    const again = await runDetection(stack);
    expect(loggedContexts(stack, "Suggested transfer pairs for user", again)).toEqual([]);
    expect(loggedCounts(stack, "Transfer-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), pairsSuggested: 0 });
    expect(await pairsAmong(stack, "alice-")).toHaveLength(4);
  });

  test("pairs each transaction once: the closest dates first, then the smaller first id", async () => {
    const stack = await start();
    const alice = await owner(stack, "alice", ["chk", "sav", "sav2"]);
    const x1 = await alice.tx("x1", "chk", 70, -10);
    const x2 = await alice.tx("x2", "sav", -70, -9);
    await alice.tx("x3", "sav", -70, -6);
    const y0 = await alice.tx("y0", "sav2", -80, -22);
    const y1 = await alice.tx("y1", "chk", 80, -20);
    await alice.tx("y2", "sav", -80, -18);

    const from = await runDetection(stack);
    expect(await pairsAmong(stack, "alice-")).toEqual([suggested(alice.id, x1, x2), suggested(alice.id, y0, y1)]);
    expect(loggedContexts(stack, "Suggested transfer pairs for user", from)).toEqual([
      { userId: alice.id, members: 1, suggested: 2, candidatesConsidered: 4 },
    ]);
    expect(loggedCounts(stack, "Transfer-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), pairsSuggested: 2 });
  });

  test("respects live and rejected pairs, cleans pairs whose transaction is gone, and survives a refused insert", async () => {
    const stack = await start();
    const alice = await owner(stack, "alice", ["chk", "sav", "sav2"]);
    const stranger = await owner(stack, "stranger", ["acc"]);
    const t = async (key: string, account: string, amount: number, days: number) => alice.tx(key, account, amount, days);

    // A live pair (suggested or confirmed) keeps both transactions out, even from another counterpart.
    const [a, b, c] = [await t("a", "chk", 10, -10), await t("b", "sav", -10, -10), await t("c", "sav2", -10, -11)];
    const [d, e, f] = [await t("d", "chk", 20, -20), await t("e", "sav", -20, -20), await t("f", "sav2", -20, -21)];
    await seedPair(stack, alice.id, a, b);
    await seedPair(stack, alice.id, d, e, { status: "confirmed" });
    // A rejected pair is not suggested again, but its transactions pair with others.
    const [g, h, i] = [await t("g", "chk", 30, -30), await t("h", "sav", -30, -30), await t("i", "sav2", -30, -32)];
    await seedPair(stack, alice.id, g, h, { status: "rejected" });
    // A deleted pair frees its transactions, but the same pair is never inserted twice: counted, not stored.
    const [j, k, l] = [await t("j", "chk", 40, -40), await t("k", "sav", -40, -40), await t("l", "sav2", -40, -41)];
    await seedPair(stack, alice.id, j, k, { is_deleted: true });
    // A live pair whose transaction was deleted is cleaned up first, freeing the other side.
    const [m, n, o] = [await t("m", "chk", 50, -50), await t("n", "sav", -50, -50), await t("o", "sav2", -50, -51)];
    await seedPair(stack, alice.id, m, n);
    await stack.db.query("UPDATE transactions SET is_deleted = TRUE WHERE transaction_id = $1", [n]);
    // Someone else's row for the same pair blocks nothing in the query, so the insert fails on the unique pair.
    const [p, q] = [await t("p", "chk", 60, -60), await t("q", "sav", -60, -60)];
    await seedPair(stack, stranger.id, p, q, { status: "rejected" });

    const from = await runDetection(stack);
    const all = await pairsAmong(stack, "alice-");
    expect(all).toEqual([
      suggested(alice.id, a, b),
      { ...suggested(alice.id, d, e), status: "confirmed" },
      { ...suggested(alice.id, g, h), status: "rejected" },
      suggested(alice.id, g, i),
      { ...suggested(alice.id, j, k), is_deleted: true },
      { ...suggested(alice.id, m, n), is_deleted: true },
      suggested(alice.id, m, o),
      { ...suggested(stranger.id, p, q), status: "rejected" },
    ]);
    expect(loggedContexts(stack, "Cleaned stale transfer pairs", from)).toEqual([{ userId: alice.id, count: 1 }]);
    expect(loggedContexts(stack, "Failed to insert transfer pair", from)).toEqual([{ userId: alice.id, transaction_id_a: p, transaction_id_b: q }]);
    // g–i, the phantom j–k, and m–o; c, f and l stay unpaired.
    expect(loggedContexts(stack, "Suggested transfer pairs for user", from)).toEqual([
      { userId: alice.id, members: 1, suggested: 3, candidatesConsidered: 5 },
    ]);
    expect(loggedCounts(stack, "Transfer-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), pairsSuggested: 3 });
    expect([c, f, l]).toHaveLength(3);
  });

  test("runs once per sharing group, pairing across its members under the first transaction's owner, and never with a stranger", async () => {
    const stack = await start();
    const alice = await owner(stack, "alice", ["chk", "sav"]);
    const bob = await owner(stack, "bob", ["sav"]);
    const carol = await owner(stack, "carol", ["chk"]);
    await shareData(stack, alice.id, bob.id);

    const aliceOut = await alice.tx("out", "chk", 300, -10);
    const bobIn = await bob.tx("in", "sav", -300, -9);
    // By UTF-16 code unit "😀" sorts first; by the database's byte order "～" does.
    const fullwidth = await seedTransaction(stack, alice.id, { transaction_id: "x-\u{FF5E}", account_id: "alice-chk", amount: 400, date: localDay(-20) });
    const emoji = await seedTransaction(stack, bob.id, { transaction_id: "x-\u{1F600}", account_id: "bob-sav", amount: -400, date: localDay(-20) });
    // A pair Bob owns keeps Alice's transaction out of the group's run.
    const held = await alice.tx("held", "chk", 500, -30);
    const holder = await bob.tx("holder", "sav", -500, -30);
    await alice.tx("rival", "sav", -500, -31);
    await seedPair(stack, bob.id, held, holder, { status: "confirmed" });
    // A pair a stranger owns blocks nothing.
    const shared = await alice.tx("shared", "chk", 600, -40);
    const partner = await alice.tx("partner", "sav", -600, -40);
    const carolIn = await carol.tx("in", "chk", -600, -40);
    await seedPair(stack, carol.id, carolIn, shared);
    // Carol's opposite amount pairs with no one in the group.
    await carol.tx("in2", "chk", -300, -10);

    const from = await runDetection(stack);
    expect(await pairsAmong(stack, "alice-")).toEqual([
      { ...suggested(bob.id, held, holder), status: "confirmed" },
      suggested(alice.id, aliceOut, bobIn),
      suggested(alice.id, partner, shared),
      suggested(carol.id, carolIn, shared),
    ]);
    expect(await pairsAmong(stack, "x-")).toEqual([suggested(bob.id, emoji.transaction_id, fullwidth.transaction_id)]);
    expect(await pairsAmong(stack, "carol-in2")).toEqual([]);
    expect(loggedContexts(stack, "Suggested transfer pairs for user", from)).toEqual([
      { userId: alice.id, members: 2, suggested: 3, candidatesConsidered: 3 },
    ]);
    for (const member of [alice, bob]) {
      const listed = await (await member.login()).get<unknown[]>("/transfers");
      expect(listed.body).toHaveLength(4);
    }
    // Carol's own pair names Alice's transaction, which Carol cannot see, so she is shown nothing.
    expect((await (await carol.login()).get<unknown[]>("/transfers")).body).toEqual([]);
    expect(loggedCounts(stack, "Transfer-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), pairsSuggested: 3 });
  });

  test("warns when a run's candidates reach the cap of 500 per member", async () => {
    const stack = await start();
    const capped = await owner(stack, "capped", ["chk", "sav"]);
    const under = await owner(stack, "under", ["chk", "sav"]);
    // 20 credits by 25 debits on one day: exactly 500 candidates. 1 by 499: one short.
    await stack.db.query(
      `INSERT INTO transactions (transaction_id, user_id, account_id, amount, date, name)
       SELECT 'capped-c' || lpad(i::text, 3, '0'), $1::uuid, 'capped-sav', -75, $2::date, 'credit' FROM generate_series(1, 20) i
       UNION ALL
       SELECT 'capped-d' || lpad(i::text, 3, '0'), $1::uuid, 'capped-chk', 75, $2::date, 'debit' FROM generate_series(1, 25) i
       UNION ALL
       SELECT 'under-c001', $3::uuid, 'under-sav', -75, $2::date, 'credit'
       UNION ALL
       SELECT 'under-d' || lpad(i::text, 3, '0'), $3::uuid, 'under-chk', 75, $2::date, 'debit' FROM generate_series(1, 499) i`,
      [capped.id, localDay(-3), under.id],
    );

    const from = await runDetection(stack);
    expect(loggedContexts(stack, "Transfer-detection candidate cap reached", from)).toEqual([{ userId: capped.id, members: 1, limit: 500 }]);
    expect(loggedContexts(stack, "Suggested transfer pairs for user", from)).toEqual([
      { userId: capped.id, members: 1, suggested: 20, candidatesConsidered: 500 },
      { userId: under.id, members: 1, suggested: 1, candidatesConsidered: 499 },
    ]);
    const pairs = await pairsAmong(stack, "capped-");
    expect(pairs).toHaveLength(20);
    expect(new Set(pairs.flatMap((pair) => [pair.transaction_id_a, pair.transaction_id_b])).size).toBe(40);
    expect(loggedCounts(stack, "Transfer-detection job completed")).toEqual({ usersProcessed: await liveUsers(stack), pairsSuggested: 21 });
  });

  test("a group whose run fails is rolled back and left out of the count, and the others carry on", async () => {
    const stack = await start();
    const victim = await owner(stack, "victim", ["chk", "sav"]);
    const fine = await owner(stack, "fine", ["chk", "sav"]);
    const deleted = await owner(stack, "deleted", ["chk", "sav"]);
    // The victim's stale pair makes the run's first write, the cleanup, fail.
    const [a, b] = [await victim.tx("a", "chk", 10, -10), await victim.tx("b", "sav", -10, -10)];
    await seedPair(stack, victim.id, a, b);
    await stack.db.query("UPDATE transactions SET is_deleted = TRUE WHERE transaction_id = $1", [b]);
    await victim.tx("c", "chk", 20, -20);
    await victim.tx("d", "sav", -20, -20);
    const [e, f] = [await fine.tx("e", "chk", 30, -30), await fine.tx("f", "sav", -30, -30)];
    // A deleted user is not run at all.
    await deleted.tx("g", "chk", 40, -40);
    await deleted.tx("h", "sav", -40, -40);
    await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE user_id = $1", [deleted.id]);

    const from = await withWritesFailing(stack, "transaction_pairs", "UPDATE", `OLD.user_id = '${victim.id}'`, () => runDetection(stack));
    expect(loggedContexts(stack, "Transfer detection failed for user", from)).toEqual([{ userId: victim.id }]);
    expect(await pairsAmong(stack, "victim-")).toEqual([suggested(victim.id, a, b)]);
    expect(await pairsAmong(stack, "fine-")).toEqual([suggested(fine.id, e, f)]);
    expect(await pairsAmong(stack, "deleted-")).toEqual([]);
    expect(loggedCounts(stack, "Transfer-detection job completed")).toEqual({ usersProcessed: (await liveUsers(stack)) - 1, pairsSuggested: 1 });
  });
});
