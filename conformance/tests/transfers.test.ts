/**
 * The transfer-pair routes: `GET /transfers`, `POST /transfers/pair` (confirm a
 * suggestion, or pair two transactions) and `DELETE /transfers` (reject a
 * pair). Pairs are shared within a sharing group, and a pair belongs to the
 * owner of its first transaction in canonical order.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, startStack, type ApiClient, type Stack } from "../harness";
import { uuidQueryCases } from "../harness/query-cases";
import { seedApiKey } from "../harness/seed/budgets";
import {
  NO_SUCH_UUID,
  TIMESTAMP,
  pick,
  seedPair,
  seedTransaction,
  shareData,
  stored,
  storedOne,
  transactionJson,
  type SeedTransaction,
} from "../harness/seed/transfers";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const SUCCESS = { status: "success" };
const failed = (message: string) => ({ status: "failed", message });
const NOT_FOUND = failed("Pair not found.");
const ALREADY_PAIRED = failed(
  "One of these transactions is already in another confirmed transfer pair. Reject or unpair the existing pair first.",
);
const GONE = failed("One or both transactions no longer exist (deleted or never belonged to this user).");

interface Person {
  id: string;
  tag: string;
  client: ApiClient;
}

let counter = 0;
/** A fresh user, signed in. Each test makes its own, so nothing leaks between tests. */
const person = async (name: string): Promise<Person> => {
  const tag = `${name}${++counter}`;
  const user = await createUser(stack, tag);
  return { id: user.user_id, tag, client: await stack.login(tag, user.password) };
};

/** A transaction of `p`, its id `<tag>-<suffix>`. */
const tx = (p: Person, suffix: string, amount = 25, extra: Partial<SeedTransaction> = {}): Promise<SeedTransaction> =>
  seedTransaction(stack, p.id, {
    transaction_id: `${p.tag}-${suffix}`,
    account_id: `${p.tag}-${amount < 0 ? "savings" : "checking"}`,
    amount,
    date: "2026-03-04",
    ...extra,
  });

/** A pair as `GET /transfers` answers with it. */
const listed = (pair_id: string, status: string, transactions: SeedTransaction[]) => ({
  pair_id,
  status,
  transactions: transactions.map(transactionJson),
  updated: expect.stringMatching(TIMESTAMP),
});

const byId = <T extends { pair_id: string }>(pairs: T[]): T[] => [...pairs].sort((a, b) => (a.pair_id < b.pair_id ? -1 : 1));

const PAIR_COLUMNS = ["user_id", "transaction_id_a", "transaction_id_b", "status", "is_deleted"];
const pairRow = async (pair_id: string) => pick(await storedOne(stack, "transaction_pairs", pair_id), PAIR_COLUMNS);
const pairsOf = async (user_id: string) =>
  (await stored(stack, "transaction_pairs", { user_id }, "t.transaction_id_a, t.transaction_id_b")).map((row) =>
    pick(row, ["pair_id", ...PAIR_COLUMNS]),
  );

describe("the transfer routes refuse anonymous callers", () => {
  const requests: [string, string, unknown?][] = [
    ["GET", "/transfers"],
    ["POST", "/transfers/pair", { transaction_id_a: "a", transaction_id_b: "b" }],
    ["DELETE", `/transfers?id=${NO_SUCH_UUID}`],
  ];

  test("every one of them", async () => {
    const anonymous = stack.anonymous();
    for (const [method, path, body] of requests) {
      const result = await anonymous.request(method, path, { body });
      expect([method, path, result.status, result.json]).toEqual([method, path, 401, failed("Not authenticated.")]);
    }
  });

  test("and callers with only an API key", async () => {
    const owner = await person("keyed");
    const key = await seedApiKey(stack, owner.id, ["transactions:suggest", "budgets:read", "budgets:write"]);
    for (const [method, path, body] of requests) {
      const result = await stack.anonymous().request(method, path, {
        body,
        headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.52.0.1" },
      });
      expect([method, path, result.status, result.json]).toEqual([method, path, 401, failed("Not authenticated.")]);
    }
  });
});

describe("GET /transfers", () => {
  test("answers an empty list to someone with no pairs", async () => {
    const alice = await person("alice");
    const result = await alice.client.get("/transfers");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: [] });
  });

  test("lists the caller's live pairs in pair id order, both transactions inline", async () => {
    const alice = await person("alice");
    const a = await tx(alice, "a", 40, { merchant_name: "Bank", label_memo: "memo", label_category_confidence: 0.5 });
    const b = await tx(alice, "b", -40, { pending: true, raw: { personal_finance_category: { primary: "TRANSFER_IN" } } });
    const c = await tx(alice, "c", 12.5, { name: null, date: "2026-01-31" });
    const d = await tx(alice, "d", -12.5, { date: "2026-02-02" });
    const first = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id);
    const second = await seedPair(stack, alice.id, c.transaction_id, d.transaction_id, { status: "confirmed" });
    const result = await alice.client.get("/transfers");
    expect(result.json).toEqual({
      status: "success",
      body: byId([listed(first, "suggested", [a, b]), listed(second, "confirmed", [c, d])]),
    });
  });

  test("hides rejected and deleted pairs, and pairs whose transaction is gone, unless asked for evictions", async () => {
    const alice = await person("alice");
    const stranger = await person("stranger");
    const [a, b, c, d, e, f, g, h] = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h"].map((s, i) => tx(alice, s, i % 2 ? -5 : 5)));
    const theirs = await tx(stranger, "x", -5);
    await stack.db.query("UPDATE transactions SET is_deleted = TRUE WHERE transaction_id = $1", [h.transaction_id]);
    const live = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id);
    const rejected = await seedPair(stack, alice.id, c.transaction_id, d.transaction_id, { status: "rejected" });
    const deleted = await seedPair(stack, alice.id, e.transaction_id, f.transaction_id, { status: "confirmed", is_deleted: true });
    const orphaned = await seedPair(stack, alice.id, g.transaction_id, h.transaction_id);
    const foreign = await seedPair(stack, alice.id, a.transaction_id, theirs.transaction_id, { status: "confirmed" });

    const visible = [listed(live, "suggested", [a, b])];
    for (const query of [undefined, { "include-deleted": "false" }, { "include-deleted": "TRUE" }, { "include-deleted": "1" }, { "include-deleted": "" }]) {
      const result = await alice.client.get("/transfers", { query });
      expect([query, result.json]).toEqual([query, { status: "success", body: visible }]);
    }

    const evicted = (pair_id: string, status: string) => ({ pair_id, status, transactions: [], updated: expect.stringMatching(TIMESTAMP) });
    const result = await alice.client.get("/transfers", { query: { "include-deleted": "true" } });
    expect(result.json).toEqual({
      status: "success",
      body: [
        ...visible,
        ...byId([evicted(rejected, "rejected"), evicted(deleted, "confirmed")]),
        ...byId([evicted(orphaned, "suggested"), evicted(foreign, "confirmed")]),
      ],
    });
  });

  test("refuses a repeated include-deleted or start-date, and a start-date that is not a calendar date", async () => {
    const alice = await person("alice");
    for (const [query, message] of [
      ["include-deleted=true&include-deleted=true", "Parameter include-deleted must be a single value, not an array"],
      ["start-date=2026-01-01&start-date=2026-01-02", "Parameter start-date must be a single value, not an array"],
      ["include-deleted=true&start-date=2026-02-30", "Field start-date must be a date"],
      ["start-date=2026-13-01", "Field start-date must be a date"],
      ["start-date=2026-1-01", "Field start-date must be a date"],
      ["start-date=not-a-date", "Field start-date must be a date"],
      ["start-date=20260101", "Field start-date must be a date"],
      ["start-date=2026-11-01T25:00", "Field start-date must be a date"],
      ["start-date=2026-11-01Tjunk", "Field start-date must be a date"],
      ["start-date=%202026-11-01", "Field start-date must be a date"],
    ]) {
      const result = await alice.client.get(`/transfers?${query}`);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
  });

  test("with start-date, answers only the pairs updated since then, evictions included", async () => {
    const alice = await person("alice");
    const [a, b, c, d, e, f, g, h] = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h"].map((s, i) => tx(alice, s, i % 2 ? -7 : 7)));
    const old = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id, { updated: "2020-01-01T00:00:00Z" });
    const mid = await seedPair(stack, alice.id, c.transaction_id, d.transaction_id, { updated: "2024-06-01T12:00:00Z" });
    const fresh = await seedPair(stack, alice.id, e.transaction_id, f.transaction_id);
    const oldRejected = await seedPair(stack, alice.id, g.transaction_id, h.transaction_id, { status: "rejected", updated: "2020-01-01T00:00:00Z" });
    const midPair = listed(mid, "suggested", [c, d]);
    const freshPair = listed(fresh, "suggested", [e, f]);

    for (const [start, expected] of [
      ["", byId([listed(old, "suggested", [a, b]), midPair, freshPair])],
      ["2024-01-01", byId([midPair, freshPair])],
      ["2024-06-01T12:00:00Z", byId([midPair, freshPair])],
      ["2024-06-01T12:00:00.001Z", [freshPair]],
      ["2024-06-01 12:00:00.001+00:00", [freshPair]],
      ["9999-12-31", []],
    ] as const) {
      const result = await alice.client.get("/transfers", { query: { "start-date": start } });
      expect([start, result.json]).toEqual([start, { status: "success", body: expected }]);
    }
    const withEvictions = await alice.client.get("/transfers", { query: { "start-date": "2019-01-01", "include-deleted": "true" } });
    expect(withEvictions.json).toEqual({
      status: "success",
      body: [
        ...byId([listed(old, "suggested", [a, b]), midPair, freshPair]),
        { pair_id: oldRejected, status: "rejected", transactions: [], updated: expect.stringMatching(TIMESTAMP) },
      ],
    });
  });

  test("reads a bare start-date as midnight in the database session's zone, not the server's", async () => {
    const alice = await person("alice");
    const [a, b] = [await tx(alice, "a"), await tx(alice, "b", -25)];
    const early = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id, { updated: "2024-06-01T03:00:00Z" });
    expect((await alice.client.get("/transfers", { query: { "start-date": "2024-06-01" } })).body).toEqual([listed(early, "suggested", [a, b])]);
    expect((await alice.client.get("/transfers", { query: { "start-date": "2024-06-01T03:00:00.001Z" } })).body).toEqual([]);
  });

  test("includes the pairs of everyone sharing data with the caller, and no one else's", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    await shareData(stack, alice.id, bob.id);
    const [a1, a2, b1, b2, c1, c2] = [
      await tx(alice, "1"),
      await tx(alice, "2", -25),
      await tx(bob, "1"),
      await tx(bob, "2", -25),
      await tx(carol, "1"),
      await tx(carol, "2", -25),
    ];
    const alices = await seedPair(stack, alice.id, a1.transaction_id, a2.transaction_id);
    const bobs = await seedPair(stack, bob.id, b1.transaction_id, b2.transaction_id, { status: "confirmed" });
    const across = await seedPair(stack, alice.id, a1.transaction_id, b2.transaction_id, { status: "rejected" });
    const carols = await seedPair(stack, carol.id, c1.transaction_id, c2.transaction_id);
    const shared = byId([listed(alices, "suggested", [a1, a2]), listed(bobs, "confirmed", [b1, b2])]);
    expect((await alice.client.get("/transfers")).json).toEqual({ status: "success", body: shared });
    expect((await bob.client.get("/transfers")).json).toEqual({ status: "success", body: shared });
    expect((await bob.client.get("/transfers", { query: { "include-deleted": "true" } })).body).toEqual([
      ...shared,
      { pair_id: across, status: "rejected", transactions: [], updated: expect.stringMatching(TIMESTAMP) },
    ]);
    expect((await carol.client.get("/transfers")).json).toEqual({ status: "success", body: [listed(carols, "suggested", [c1, c2])] });
  });
});

describe("POST /transfers/pair", () => {
  test("refuses a body that is not an object", async () => {
    const alice = await person("alice");
    for (const [body, message] of [
      [undefined, "Request body is required"],
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      [["pair_id"], "Request body must be an object"],
      ["text", "Request body must be an object"],
      [5, "Request body must be an object"],
      [true, "Request body must be an object"],
    ] as const) {
      const result = await alice.client.post("/transfers/pair", body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
  });

  test("refuses a pair_id that is not a UUID string, before anything else", async () => {
    const alice = await person("alice");
    for (const pair_id of [null, 5, true, "", "not-a-uuid", NO_SUCH_UUID.replace(/-/g, ""), ` ${NO_SUCH_UUID}`, [NO_SUCH_UUID], {}]) {
      const result = await alice.client.post("/transfers/pair", { pair_id, transaction_id_a: "a", transaction_id_b: "b" });
      expect([pair_id, result.json]).toEqual([pair_id, failed("Field pair_id must be a uuid")]);
    }
  });

  test("confirms a suggested pair, and rejects the other suggestions for its transactions", async () => {
    const alice = await person("alice");
    const [a, b, c, d, e, f] = await Promise.all(["a", "b", "c", "d", "e", "f"].map((s) => tx(alice, s)));
    const target = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id);
    const rivalA = await seedPair(stack, alice.id, a.transaction_id, c.transaction_id);
    const rivalB = await seedPair(stack, alice.id, d.transaction_id, b.transaction_id);
    const rejected = await seedPair(stack, alice.id, b.transaction_id, e.transaction_id, { status: "rejected", updated: "2020-01-01T00:00:00Z" });
    const deletedRival = await seedPair(stack, alice.id, a.transaction_id, f.transaction_id, { is_deleted: true, updated: "2020-01-01T00:00:00Z" });
    const unrelated = await seedPair(stack, alice.id, e.transaction_id, f.transaction_id, { updated: "2020-01-01T00:00:00Z" });
    const before = await storedOne(stack, "transaction_pairs", target);

    // A pair_id wins over transaction ids.
    const result = await alice.client.post("/transfers/pair", { pair_id: target, transaction_id_a: "x", transaction_id_b: "y", status: "suggested" });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: { pair_id: target } });

    expect(await pairRow(target)).toEqual({ user_id: alice.id, transaction_id_a: a.transaction_id, transaction_id_b: b.transaction_id, status: "confirmed", is_deleted: false });
    expect(String((await storedOne(stack, "transaction_pairs", target))!.updated) > String(before!.updated)).toBe(true);
    expect((await pairRow(rivalA))!.status).toBe("rejected");
    expect((await pairRow(rivalB))!.status).toBe("rejected");
    for (const untouched of [rejected, deletedRival, unrelated]) {
      expect(String((await storedOne(stack, "transaction_pairs", untouched))!.updated)).toStartWith("2020-01-01");
    }
    expect((await pairRow(deletedRival))!.status).toBe("suggested");

    // Confirming it again changes nothing and succeeds.
    expect((await alice.client.post("/transfers/pair", { pair_id: target })).json).toEqual({ status: "success", body: { pair_id: target } });
    expect((await pairRow(target))!.status).toBe("confirmed");
  });

  test("finds a pair by its id in capitals, and answers with the id as sent", async () => {
    const alice = await person("alice");
    const [a, b] = [await tx(alice, "a"), await tx(alice, "b")];
    const target = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id);
    const result = await alice.client.post("/transfers/pair", { pair_id: target.toUpperCase() });
    expect(result.json).toEqual({ status: "success", body: { pair_id: target.toUpperCase() } });
    expect((await pairRow(target))!.status).toBe("confirmed");
  });

  test("answers 'Pair not found.' for a missing, rejected, deleted or stranger's pair, and changes nothing", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map((s) => tx(alice, s)));
    const [x, y] = [await tx(stranger, "x"), await tx(stranger, "y")];
    const rejected = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id, { status: "rejected" });
    const deleted = await seedPair(stack, alice.id, c.transaction_id, d.transaction_id, { is_deleted: true });
    const theirs = await seedPair(stack, stranger.id, x.transaction_id, y.transaction_id);
    const before = [await pairsOf(alice.id), await pairsOf(stranger.id)];
    for (const pair_id of [NO_SUCH_UUID, rejected, deleted, theirs]) {
      expect((await alice.client.post("/transfers/pair", { pair_id })).json).toEqual(NOT_FOUND);
    }
    expect([await pairsOf(alice.id), await pairsOf(stranger.id)]).toEqual(before);
  });

  test("refuses to confirm a pair whose transaction is already in another confirmed pair", async () => {
    const alice = await person("alice");
    const [a, b, c] = await Promise.all(["a", "b", "c"].map((s) => tx(alice, s)));
    const target = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id);
    await seedPair(stack, alice.id, b.transaction_id, c.transaction_id, { status: "confirmed" });
    const before = await pairsOf(alice.id);
    expect((await alice.client.post("/transfers/pair", { pair_id: target })).json).toEqual(ALREADY_PAIRED);
    expect(await pairsOf(alice.id)).toEqual(before);
  });

  test("confirms a pair of someone sharing data with the caller, and rejects rival suggestions across the group", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await shareData(stack, alice.id, bob.id);
    const [a, b] = [await tx(alice, "a"), await tx(bob, "b", -25)];
    const c = await tx(bob, "c", -25);
    const target = await seedPair(stack, bob.id, a.transaction_id, b.transaction_id);
    const rival = await seedPair(stack, alice.id, a.transaction_id, c.transaction_id);
    expect((await alice.client.post("/transfers/pair", { pair_id: target })).json).toEqual({ status: "success", body: { pair_id: target } });
    expect(await pairRow(target)).toEqual({ user_id: bob.id, transaction_id_a: a.transaction_id, transaction_id_b: b.transaction_id, status: "confirmed", is_deleted: false });
    expect((await pairRow(rival))!.status).toBe("rejected");
  });

  test("refuses a missing, non-string or overlong transaction id, a before b", async () => {
    const alice = await person("alice");
    const long = "t".repeat(256);
    // 128 characters outside the Basic Multilingual Plane are 256 UTF-16 code units.
    const wide = "😀".repeat(128);
    for (const [body, message] of [
      [{}, "Missing required field: transaction_id_a"],
      [{ transaction_id_b: "b" }, "Missing required field: transaction_id_a"],
      [{ transaction_id_a: null, transaction_id_b: "b" }, "Missing required field: transaction_id_a"],
      [{ transaction_id_a: 5, transaction_id_b: "b" }, "Field transaction_id_a must be a string"],
      [{ transaction_id_a: ["a"], transaction_id_b: "b" }, "Field transaction_id_a must be a string"],
      [{ transaction_id_a: { id: "a" }, transaction_id_b: 5 }, "Field transaction_id_a must be a string"],
      [{ transaction_id_a: long, transaction_id_b: 5 }, "Field transaction_id_a must be at most 255 characters"],
      [{ transaction_id_a: wide, transaction_id_b: "b" }, "Field transaction_id_a must be at most 255 characters"],
      [{ transaction_id_a: "a" }, "Missing required field: transaction_id_b"],
      [{ transaction_id_a: "a", transaction_id_b: null }, "Missing required field: transaction_id_b"],
      [{ transaction_id_a: "a", transaction_id_b: false }, "Field transaction_id_b must be a string"],
      [{ transaction_id_a: "a", transaction_id_b: long }, "Field transaction_id_b must be at most 255 characters"],
      [{ transaction_id_a: "a", transaction_id_b: wide }, "Field transaction_id_b must be at most 255 characters"],
    ] as const) {
      const result = await alice.client.post("/transfers/pair", body);
      expect([body, result.json]).toEqual([body, failed(message)]);
    }
    // At the column's length, the ids reach the lookup, which finds nothing.
    for (const id of ["t".repeat(255), `${"😀".repeat(127)}t`, ""]) {
      expect((await alice.client.post("/transfers/pair", { transaction_id_a: id, transaction_id_b: id })).json).toEqual(GONE);
    }
    expect(await pairsOf(alice.id)).toEqual([]);
  });

  test("pairs two transactions in canonical order, as suggested unless the status is exactly 'confirmed'", async () => {
    const alice = await person("alice");
    for (const [status, expected] of [
      [undefined, "suggested"],
      ["confirmed", "confirmed"],
      ["suggested", "suggested"],
      ["CONFIRMED", "suggested"],
      ["rejected", "suggested"],
      [true, "suggested"],
      [null, "suggested"],
    ] as const) {
      const n = ++counter;
      const [low, high] = [await tx(alice, `${n}-a`), await tx(alice, `${n}-b`, -25)];
      const result = await alice.client.post<{ pair_id: string }>("/transfers/pair", {
        transaction_id_a: high.transaction_id,
        transaction_id_b: low.transaction_id,
        status,
      });
      expect([status, result.json]).toEqual([status, { status: "success", body: { pair_id: expect.stringMatching(/^[0-9a-f-]{36}$/) } }]);
      expect([status, await pairRow(result.body.pair_id)]).toEqual([
        status,
        { user_id: alice.id, transaction_id_a: low.transaction_id, transaction_id_b: high.transaction_id, status: expected, is_deleted: false },
      ]);
    }
  });

  test("orders ids the way JavaScript compares strings, not by the database's collation", async () => {
    const alice = await person("alice");
    // U+1F600 sorts below U+FF5E by UTF-16 code unit, above it by code point and in UTF-8.
    const [fullwidth, emoji] = [await tx(alice, "\u{FF5E}"), await tx(alice, "\u{1F600}", -25)];
    const result = await alice.client.post<{ pair_id: string }>("/transfers/pair", {
      transaction_id_a: fullwidth.transaction_id,
      transaction_id_b: emoji.transaction_id,
    });
    expect(await pairRow(result.body.pair_id)).toEqual({
      user_id: alice.id,
      transaction_id_a: emoji.transaction_id,
      transaction_id_b: fullwidth.transaction_id,
      status: "suggested",
      is_deleted: false,
    });
  });

  // Pins a Bun behaviour that looks like a bug, kept because Bun is the reference: pairing a suggested pair again as 'confirmed' leaves it suggested.
  // See "Pinned Bun behaviours" in conformance/README.md before changing it.
  test("pairing again keeps a live pair as it is, and revives a rejected or deleted one with the new status", async () => {
    const alice = await person("alice");
    const [a, b, c, d, e, f] = await Promise.all(["a", "b", "c", "d", "e", "f"].map((s) => tx(alice, s)));
    const live = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id, { updated: "2020-01-01T00:00:00Z" });
    const rejected = await seedPair(stack, alice.id, c.transaction_id, d.transaction_id, { status: "rejected", updated: "2020-01-01T00:00:00Z" });
    const deleted = await seedPair(stack, alice.id, e.transaction_id, f.transaction_id, { status: "confirmed", is_deleted: true, updated: "2020-01-01T00:00:00Z" });

    const again = await alice.client.post("/transfers/pair", { transaction_id_a: b.transaction_id, transaction_id_b: a.transaction_id, status: "confirmed" });
    expect(again.json).toEqual({ status: "success", body: { pair_id: live } });
    expect((await pairRow(live))!.status).toBe("suggested");
    expect(String((await storedOne(stack, "transaction_pairs", live))!.updated)).toStartWith("2020-01-01");

    const revived = await alice.client.post("/transfers/pair", { transaction_id_a: c.transaction_id, transaction_id_b: d.transaction_id, status: "confirmed" });
    expect(revived.json).toEqual({ status: "success", body: { pair_id: rejected } });
    expect((await pairRow(rejected))!.status).toBe("confirmed");
    expect(String((await storedOne(stack, "transaction_pairs", rejected))!.updated)).not.toStartWith("2020-01-01");

    const undeleted = await alice.client.post("/transfers/pair", { transaction_id_a: e.transaction_id, transaction_id_b: f.transaction_id });
    expect(undeleted.json).toEqual({ status: "success", body: { pair_id: deleted } });
    expect(await pairRow(deleted)).toEqual({ user_id: alice.id, transaction_id_a: e.transaction_id, transaction_id_b: f.transaction_id, status: "suggested", is_deleted: false });
    expect(String((await storedOne(stack, "transaction_pairs", deleted))!.updated)).not.toStartWith("2020-01-01");
  });

  test("rejects the other live suggestions for either transaction, and leaves confirmed ones alone", async () => {
    const alice = await person("alice");
    const [a, b, c, d, e] = await Promise.all(["a", "b", "c", "d", "e"].map((s) => tx(alice, s)));
    const rivalA = await seedPair(stack, alice.id, a.transaction_id, c.transaction_id);
    const rivalB = await seedPair(stack, alice.id, d.transaction_id, b.transaction_id);
    const elsewhere = await seedPair(stack, alice.id, d.transaction_id, e.transaction_id);
    const result = await alice.client.post<{ pair_id: string }>("/transfers/pair", { transaction_id_a: a.transaction_id, transaction_id_b: b.transaction_id });
    expect(result.json.status).toBe("success");
    expect((await pairRow(rivalA))!.status).toBe("rejected");
    expect((await pairRow(rivalB))!.status).toBe("rejected");
    expect((await pairRow(elsewhere))!.status).toBe("suggested");
    expect((await pairRow(result.body.pair_id))!.status).toBe("suggested");
  });

  test("refuses a transaction already in another confirmed pair", async () => {
    const alice = await person("alice");
    const [a, b, c] = await Promise.all(["a", "b", "c"].map((s) => tx(alice, s)));
    await seedPair(stack, alice.id, a.transaction_id, c.transaction_id, { status: "confirmed" });
    const before = await pairsOf(alice.id);
    for (const [first, second] of [
      [a, b],
      [b, a],
    ]) {
      expect((await alice.client.post("/transfers/pair", { transaction_id_a: first.transaction_id, transaction_id_b: second.transaction_id, status: "confirmed" })).json).toEqual(ALREADY_PAIRED);
    }
    expect(await pairsOf(alice.id)).toEqual(before);
  });

  test("refuses a transaction that is missing, deleted or a stranger's", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const [a, b] = [await tx(alice, "a"), await tx(alice, "b", 25, { is_deleted: true })];
    const theirs = await tx(stranger, "x");
    for (const other of ["nope", b.transaction_id, theirs.transaction_id]) {
      expect((await alice.client.post("/transfers/pair", { transaction_id_a: a.transaction_id, transaction_id_b: other })).json).toEqual(GONE);
      expect((await alice.client.post("/transfers/pair", { transaction_id_a: other, transaction_id_b: a.transaction_id })).json).toEqual(GONE);
    }
    expect(await pairsOf(alice.id)).toEqual([]);
    expect(await pairsOf(stranger.id)).toEqual([]);
  });

  // Pins a Bun behaviour that looks like a bug, kept because Bun is the reference: a transaction can be paired with itself.
  // See "Pinned Bun behaviours" in conformance/README.md before changing it.
  test("pairs a transaction with itself, as the lookup finds it once", async () => {
    const alice = await person("alice");
    const a = await tx(alice, "a");
    const result = await alice.client.post<{ pair_id: string }>("/transfers/pair", { transaction_id_a: a.transaction_id, transaction_id_b: a.transaction_id });
    expect(result.json).toEqual({ status: "success", body: { pair_id: expect.any(String) } });
    expect(await pairRow(result.body.pair_id)).toEqual({ user_id: alice.id, transaction_id_a: a.transaction_id, transaction_id_b: a.transaction_id, status: "suggested", is_deleted: false });
  });

  test("pairs across a sharing group under the owner of the first transaction, whoever asks", async () => {
    const [alice, bob, carol, stranger] = [await person("alice"), await person("bob"), await person("carol"), await person("stranger")];
    await shareData(stack, alice.id, bob.id, carol.id);
    const a = await tx(alice, "a");
    const b = await tx(bob, "b", -25);
    const theirs = await tx(stranger, "x", -25);
    const [first, second] = a.transaction_id < b.transaction_id ? [a, b] : [b, a];
    const firstOwner = first === a ? alice.id : bob.id;

    const result = await carol.client.post<{ pair_id: string }>("/transfers/pair", { transaction_id_a: second.transaction_id, transaction_id_b: first.transaction_id, status: "confirmed" });
    expect(result.json.status).toBe("success");
    expect(await pairRow(result.body.pair_id)).toEqual({ user_id: firstOwner, transaction_id_a: first.transaction_id, transaction_id_b: second.transaction_id, status: "confirmed", is_deleted: false });
    expect(await pairsOf(carol.id)).toEqual([]);

    // Bob sees it confirmed; a stranger's transaction is out of the group's reach.
    expect((await bob.client.get<{ pair_id: string }[]>("/transfers")).body.map((p) => p.pair_id)).toEqual([result.body.pair_id]);
    expect((await alice.client.post("/transfers/pair", { transaction_id_a: a.transaction_id, transaction_id_b: theirs.transaction_id })).json).toEqual(GONE);
    expect((await stranger.client.post("/transfers/pair", { transaction_id_a: a.transaction_id, transaction_id_b: theirs.transaction_id })).json).toEqual(GONE);
  });
});

describe("DELETE /transfers", () => {
  test("refuses a missing, repeated, empty or malformed id", async () => {
    const alice = await person("alice");
    for (const [query, message] of uuidQueryCases("id")) {
      const result = await alice.client.delete(`/transfers${query}`);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
  });

  test("rejects the caller's pair, suggested or confirmed, and a group member's", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await shareData(stack, alice.id, bob.id);
    const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map((s) => tx(alice, s)));
    const [x, y] = [await tx(bob, "x"), await tx(bob, "y")];
    const suggested = await seedPair(stack, alice.id, a.transaction_id, b.transaction_id, { updated: "2020-01-01T00:00:00Z" });
    const confirmed = await seedPair(stack, alice.id, c.transaction_id, d.transaction_id, { status: "confirmed" });
    const bobs = await seedPair(stack, bob.id, x.transaction_id, y.transaction_id);
    for (const pair_id of [suggested, confirmed, bobs]) {
      const result = await alice.client.delete("/transfers", { query: { id: pair_id } });
      expect(result.status).toBe(200);
      expect(result.json).toEqual(SUCCESS);
      expect((await pairRow(pair_id))!.status).toBe("rejected");
    }
    expect(String((await storedOne(stack, "transaction_pairs", suggested))!.updated)).not.toStartWith("2020-01-01");
    expect((await alice.client.get("/transfers")).body).toEqual([]);
  });

  test("answers success for a missing, deleted or stranger's pair, and changes nothing", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const [a, b] = [await tx(alice, "a"), await tx(alice, "b")];
    const [x, y] = [await tx(stranger, "x"), await tx(stranger, "y")];
    await seedPair(stack, alice.id, a.transaction_id, b.transaction_id, { is_deleted: true, status: "confirmed" });
    const deleted = (await pairsOf(alice.id))[0]!.pair_id as string;
    const theirs = await seedPair(stack, stranger.id, x.transaction_id, y.transaction_id);
    const before = [await pairsOf(alice.id), await pairsOf(stranger.id)];
    for (const id of [NO_SUCH_UUID, deleted, theirs, theirs.toUpperCase()]) {
      expect((await alice.client.delete("/transfers", { query: { id } })).json).toEqual(SUCCESS);
    }
    expect([await pairsOf(alice.id), await pairsOf(stranger.id)]).toEqual(before);
  });
});
