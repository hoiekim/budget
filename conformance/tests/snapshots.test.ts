/**
 * Account-balance snapshots and the snapshot list every snapshot type
 * streams through: `GET /snapshots`, `POST /snapshot`, `DELETE /snapshot`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { seedApiKey } from "../harness/seed/budgets";
import {
  localMidnight,
  seedAccount,
  seedAccountSnapshots,
  seedSecurity,
  seedSnapshot,
  shareData,
  softDelete,
  squashedDay,
  storedRow,
  storedRows,
  withWritesBroken,
  withoutStamps,
  type StoredRow,
} from "../harness/seed/snapshots";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
  await seedSecurityPrices();
});
afterAll(() => stack.stop());

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SUCCESS = { status: "success" };
const failed = (message: string) => ({ status: "failed", message });

interface Person {
  client: ApiClient;
  user_id: string;
}

let counter = 0;
/** A user of their own, signed in, so what they list is exactly what the test gave them. */
const person = async (name: string): Promise<Person> => {
  const { client, user } = await createUserClient(stack, `${name}-${++counter}`);
  return { client, user_id: user.user_id };
};

/** The ISO text of an instant written as a timestamp. */
const iso = (text: string) => new Date(text).toISOString();

/** When every seeded row was last written, so date-range filters on `updated` are deterministic. */
const SEEDED_AT = "2026-01-10T12:00:00Z";
const stampAll = (ids: string[], at = SEEDED_AT) =>
  stack.db.query("UPDATE snapshots SET updated = $1::timestamptz WHERE snapshot_id = ANY($2::text[])", [at, ids]);

// ---------------------------------------------------------------------------
// The JSON a stored snapshot is listed as
// ---------------------------------------------------------------------------

interface AccountRow {
  snapshot_id: string;
  user_id: string;
  account_id: string;
  snapshot_date: string;
  current?: number | null;
  available?: number | null;
  limit?: number | null;
  iso_currency_code?: string | null;
  is_deleted?: boolean;
}

const seedAccountRow = async (row: AccountRow): Promise<string> => {
  await seedSnapshot(stack, {
    snapshot_id: row.snapshot_id,
    user_id: row.user_id,
    snapshot_type: "account_balance",
    snapshot_date: row.snapshot_date,
    account_id: row.account_id,
    balances_current: row.current ?? null,
    balances_available: row.available ?? null,
    balances_limit: row.limit ?? null,
    balances_iso_currency_code: row.iso_currency_code ?? null,
    is_deleted: row.is_deleted ?? false,
  });
  return row.snapshot_id;
};

const accountJson = (row: AccountRow) => ({
  snapshot: { snapshot_id: row.snapshot_id, date: iso(row.snapshot_date), is_deleted: row.is_deleted ?? false },
  user: { user_id: row.user_id },
  account: {
    account_id: row.account_id,
    balances: {
      current: row.current ?? null,
      available: row.available ?? null,
      limit: row.limit ?? null,
      iso_currency_code: row.iso_currency_code ?? null,
      unofficial_currency_code: null,
    },
  },
});

interface HoldingRow {
  snapshot_id: string;
  user_id: string;
  snapshot_date: string;
  holding_account_id: string;
  holding_security_id: string;
  institution_price?: number | null;
  institution_value?: number | null;
  cost_basis?: number | null;
  quantity?: number | null;
  is_deleted?: boolean;
}

const seedHoldingRow = async (row: HoldingRow): Promise<string> => {
  await seedSnapshot(stack, {
    snapshot_id: row.snapshot_id,
    user_id: row.user_id,
    snapshot_type: "holding",
    snapshot_date: row.snapshot_date,
    holding_account_id: row.holding_account_id,
    holding_security_id: row.holding_security_id,
    institution_price: row.institution_price ?? null,
    institution_value: row.institution_value ?? null,
    cost_basis: row.cost_basis ?? null,
    quantity: row.quantity ?? null,
    is_deleted: row.is_deleted ?? false,
  });
  return row.snapshot_id;
};

/** A holding snapshot lists a missing price, value and quantity as 0, and a missing cost basis as null. */
const holdingJson = (row: HoldingRow) => ({
  snapshot: { snapshot_id: row.snapshot_id, date: iso(row.snapshot_date), is_deleted: row.is_deleted ?? false },
  user: { user_id: row.user_id },
  holding: {
    account_id: row.holding_account_id,
    security_id: row.holding_security_id,
    institution_price: row.institution_price ?? 0,
    institution_value: row.institution_value ?? 0,
    cost_basis: row.cost_basis ?? null,
    quantity: row.quantity ?? 0,
  },
});

/** A securities row as the API lists it: the columns, then the fields kept in `raw`. */
const securityJson = (row: Record<string, unknown>, raw: Record<string, unknown> = {}) => ({
  security_id: row.security_id,
  name: row.name ?? null,
  ticker_symbol: row.ticker_symbol ?? null,
  type: row.type ?? null,
  close_price: row.close_price ?? null,
  close_price_as_of: row.close_price_as_of ?? null,
  iso_currency_code: row.iso_currency_code ?? null,
  isin: row.isin ?? null,
  cusip: row.cusip ?? null,
  ...Object.fromEntries(
    [
      "sedol",
      "institution_security_id",
      "institution_id",
      "proxy_security_id",
      "is_cash_equivalent",
      "unofficial_currency_code",
      "market_identifier_code",
      "sector",
      "industry",
      "option_contract",
      "fixed_income",
    ].map((field) => [field, raw[field] ?? null]),
  ),
});

// ---------------------------------------------------------------------------
// Security prices: shared by every user, listed to all of them
// ---------------------------------------------------------------------------

const PRICED = { security_id: "snap-sec-priced", name: "Priced Fund", ticker_symbol: "PRICED", type: "etf", close_price: 210, close_price_as_of: "2026-01-08", iso_currency_code: "USD", isin: "US0000000001", cusip: "000000001" };
const PRICED_RAW = { sedol: "B0YBKJ7", is_cash_equivalent: false, sector: "Finance", ignored: "x" };
const BARE = { security_id: "snap-sec-bare", ticker_symbol: "BARE" };

/** Every security snapshot in the database, as every unnarrowed list ends with them, in id order. */
let SECURITY_SNAPSHOTS: unknown[] = [];

const seedSecurityPrices = async () => {
  await seedSecurity(stack, PRICED.security_id, { ...PRICED, raw: PRICED_RAW });
  await seedSecurity(stack, BARE.security_id, BARE);
  const rows = [
    { snapshot_id: "snap-sec-priced-20260105", security_id: PRICED.security_id, snapshot_date: "2026-01-05T00:00:00Z", close_price: 101.5 },
    { snapshot_id: "snap-sec-priced-20260106", security_id: PRICED.security_id, snapshot_date: "2026-01-06T12:00:00Z", close_price: null },
    { snapshot_id: "snap-sec-priced-20260107", security_id: PRICED.security_id, snapshot_date: "2026-01-07T00:00:00Z", close_price: 99, is_deleted: true },
    { snapshot_id: "snap-sec-bare-20260105", security_id: BARE.security_id, snapshot_date: "2026-01-05T00:00:00Z", close_price: 7.25 },
    // A price whose security row is gone: listed as stored.
    { snapshot_id: "snap-sec-orphan-20260105", security_id: "snap-sec-orphan", snapshot_date: "2026-01-05T00:00:00Z", close_price: 3 },
  ];
  for (const row of rows) await seedSnapshot(stack, { snapshot_type: "security", is_deleted: false, ...row });
  await stampAll(rows.map((row) => row.snapshot_id));
  const enriched = (security: Record<string, unknown>, raw?: Record<string, unknown>) => (close_price: number | null) => ({
    ...securityJson(security, raw),
    close_price,
  });
  const priced = enriched(PRICED, PRICED_RAW);
  const bare = enriched(BARE);
  SECURITY_SNAPSHOTS = rows
    .map((row) => ({
      snapshot: { snapshot_id: row.snapshot_id, date: iso(row.snapshot_date), is_deleted: row.is_deleted ?? false },
      security:
        row.security_id === PRICED.security_id
          ? priced(row.close_price)
          : row.security_id === BARE.security_id
            ? bare(row.close_price)
            : { security_id: row.security_id, close_price: row.close_price },
    }))
    .sort((a, b) => (a.snapshot.snapshot_id < b.snapshot.snapshot_id ? -1 : 1));
};

const listSnapshots = async (client: ApiClient, query?: Record<string, string>) => {
  const result = await client.get<unknown[]>("/snapshots", { query });
  expect(result.status).toBe(200);
  expect(result.headers.get("content-type")).toContain("application/json");
  return result;
};

const byId = <T extends { snapshot: { snapshot_id: string } }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.snapshot.snapshot_id < b.snapshot.snapshot_id ? -1 : 1));

describe("a caller without a session", () => {
  test("is refused on every route, and nothing is changed", async () => {
    const { user_id } = await person("anon-owner");
    await seedAccount(stack, user_id, `acc-anon-${counter}`);
    const snapshot_id = await seedAccountRow({ snapshot_id: `acc-anon-${counter}-20260101`, user_id, account_id: `acc-anon-${counter}`, snapshot_date: "2026-01-01T00:00:00Z" });
    const before = await storedRows(stack, "snapshots");
    const anonymous = stack.anonymous();
    // An API key does not do either: these routes take a session only.
    const key = await seedApiKey(stack, user_id, ["transactions:suggest", "budgets:read", "budgets:write"]);
    for (const [method, path, body] of [
      ["GET", "/snapshots"],
      ["POST", "/snapshot", { snapshot: {}, account: { account_id: `acc-anon-${counter}` } }],
      ["DELETE", `/snapshot?id=${snapshot_id}`],
    ] as const) {
      for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.41.0.1" }] as Record<string, string>[]) {
        const result = await anonymous.request(method, path, { body, headers });
        expect([method, path, result.status]).toEqual([method, path, 401]);
        expect(result.json).toEqual(failed("Not authenticated."));
      }
    }
    expect(await storedRows(stack, "snapshots")).toEqual(before);
  });
});

describe("GET /snapshots", () => {
  test("lists the caller's snapshots of every type and a sharing-group member's, then every security price, tombstones included", async () => {
    const [owner, member, stranger] = [await person("lister"), await person("lister-member"), await person("lister-stranger")];
    await shareData(stack, owner.user_id, member.user_id);
    const n = counter;
    const mine: AccountRow = { snapshot_id: `l${n}-acc-20260102`, user_id: owner.user_id, account_id: `l${n}-acc`, snapshot_date: "2026-01-02T00:00:00Z", current: 1234.56, available: 1000, limit: 5000, iso_currency_code: "USD" };
    const bare: AccountRow = { snapshot_id: `l${n}-acc-20260103`, user_id: owner.user_id, account_id: `l${n}-acc`, snapshot_date: "2026-01-03T08:30:00Z" };
    const deleted: AccountRow = { snapshot_id: `l${n}-acc-20260104`, user_id: owner.user_id, account_id: `l${n}-acc`, snapshot_date: "2026-01-04T00:00:00Z", current: -12.5, is_deleted: true };
    const theirs: AccountRow = { snapshot_id: `l${n}-macc-20260102`, user_id: member.user_id, account_id: `l${n}-macc`, snapshot_date: "2026-01-02T00:00:00Z", current: 7 };
    const holding: HoldingRow = { snapshot_id: `holding-l${n}-acc-sec-20260102`, user_id: owner.user_id, snapshot_date: "2026-01-02T00:00:00Z", holding_account_id: `l${n}-acc`, holding_security_id: PRICED.security_id, institution_price: 101.123456, institution_value: 1011.23, cost_basis: 900, quantity: 10.5 };
    const emptyHolding: HoldingRow = { snapshot_id: `holding-l${n}-acc-bare-20260102`, user_id: owner.user_id, snapshot_date: "2026-01-02T00:00:00Z", holding_account_id: `l${n}-acc`, holding_security_id: BARE.security_id };
    for (const row of [mine, bare, deleted, theirs]) await seedAccountRow(row);
    for (const row of [holding, emptyHolding]) await seedHoldingRow(row);
    await seedAccountRow({ snapshot_id: `l${n}-sacc-20260102`, user_id: stranger.user_id, account_id: `l${n}-sacc`, snapshot_date: "2026-01-02T00:00:00Z", current: 1 });

    const own = byId([accountJson(mine), accountJson(bare), accountJson(deleted), accountJson(theirs), holdingJson(holding), holdingJson(emptyHolding)]);
    expect((await listSnapshots(owner.client)).json).toEqual({ status: "success", body: [...own, ...SECURITY_SNAPSHOTS] });
    // The member sees the same, and the stranger only their own and the prices.
    expect((await listSnapshots(member.client)).json).toEqual({ status: "success", body: [...own, ...SECURITY_SNAPSHOTS] });
    expect((await listSnapshots(stranger.client)).body).toEqual([
      accountJson({ snapshot_id: `l${n}-sacc-20260102`, user_id: stranger.user_id, account_id: `l${n}-sacc`, snapshot_date: "2026-01-02T00:00:00Z", current: 1 }),
      ...SECURITY_SNAPSHOTS,
    ]);
    // Someone with no snapshots still gets the prices.
    const nobody = await person("lister-empty");
    expect((await listSnapshots(nobody.client)).json).toEqual({ status: "success", body: SECURITY_SNAPSHOTS });
  });

  test("streams a list longer than one batch, in id order", async () => {
    const owner = await person("streamer");
    const account_id = `stream-${counter}`;
    const count = 1203;
    await seedAccountSnapshots(stack, owner.user_id, account_id, count, "2026-01-31");
    const expected = Array.from({ length: count }, (_, n) => {
      const day = new Date(Date.UTC(2026, 0, 31 - n));
      const ymd = day.toISOString().slice(0, 10);
      return accountJson({ snapshot_id: `${account_id}-${ymd.replace(/-/g, "")}`, user_id: owner.user_id, account_id, snapshot_date: `${ymd}T00:00:00Z`, current: 1000 + n, iso_currency_code: "USD" });
    });
    const sorted = byId(expected);
    const typed = await listSnapshots(owner.client, { "snapshot-type": "account_balance" });
    expect(typed.body).toHaveLength(count);
    expect(typed.json).toEqual({ status: "success", body: sorted });
    // Unnarrowed, the prices follow the last batch.
    expect((await listSnapshots(owner.client)).body).toEqual([...sorted, ...SECURITY_SNAPSHOTS]);
    // Narrowed to the account, the holding read that follows finds nothing.
    expect((await listSnapshots(owner.client, { "account-id": account_id })).body).toEqual(sorted);
  });

  describe("narrowed", () => {
    let owner: Person;
    let member: Person;
    let n: number;
    let rows: { a1: AccountRow; a1b: AccountRow; a2: AccountRow; m1: AccountRow; h1: HoldingRow; h1bare: HoldingRow; h2: HoldingRow; hm: HoldingRow; withSecurity: AccountRow };
    beforeAll(async () => {
      [owner, member] = [await person("narrow"), await person("narrow-member")];
      await shareData(stack, owner.user_id, member.user_id);
      n = counter;
      rows = {
        a1: { snapshot_id: `n${n}-a1-20260101`, user_id: owner.user_id, account_id: `n${n}-a1`, snapshot_date: "2026-01-01T00:00:00Z", current: 1 },
        a1b: { snapshot_id: `n${n}-a1-20260102`, user_id: owner.user_id, account_id: `n${n}-a1`, snapshot_date: "2026-01-02T00:00:00Z", current: 2, is_deleted: true },
        a2: { snapshot_id: `n${n}-a2-20260101`, user_id: owner.user_id, account_id: `n${n}-a2`, snapshot_date: "2026-01-01T00:00:00Z", current: 3 },
        m1: { snapshot_id: `n${n}-m1-20260101`, user_id: member.user_id, account_id: `n${n}-a1`, snapshot_date: "2026-01-01T00:00:00Z", current: 4 },
        h1: { snapshot_id: `holding-n${n}-a1-priced-20260101`, user_id: owner.user_id, snapshot_date: "2026-01-01T00:00:00Z", holding_account_id: `n${n}-a1`, holding_security_id: PRICED.security_id, quantity: 1 },
        h1bare: { snapshot_id: `holding-n${n}-a1-bare-20260101`, user_id: owner.user_id, snapshot_date: "2026-01-01T00:00:00Z", holding_account_id: `n${n}-a1`, holding_security_id: BARE.security_id, quantity: 2, is_deleted: true },
        h2: { snapshot_id: `holding-n${n}-a2-priced-20260101`, user_id: owner.user_id, snapshot_date: "2026-01-01T00:00:00Z", holding_account_id: `n${n}-a2`, holding_security_id: PRICED.security_id, quantity: 3 },
        hm: { snapshot_id: `holding-n${n}-a1-priced-20260102`, user_id: member.user_id, snapshot_date: "2026-01-02T00:00:00Z", holding_account_id: `n${n}-a1`, holding_security_id: PRICED.security_id, quantity: 4 },
        // An account snapshot that also names a security: the owned read's `security_id` filter finds it.
        withSecurity: { snapshot_id: `n${n}-a2-20260103`, user_id: owner.user_id, account_id: `n${n}-a2`, snapshot_date: "2026-01-03T00:00:00Z", current: 5 },
      };
      for (const row of [rows.a1, rows.a1b, rows.a2, rows.m1, rows.withSecurity]) await seedAccountRow(row);
      for (const row of [rows.h1, rows.h1bare, rows.h2, rows.hm]) await seedHoldingRow(row);
      await stack.db.query("UPDATE snapshots SET security_id = $1 WHERE snapshot_id = $2", [BARE.security_id, rows.withSecurity.snapshot_id]);
      await stampAll(Object.values(rows).map((row) => row.snapshot_id));
    });

    test("to an account: its account snapshots, then its holding snapshots, and no prices", async () => {
      const { a1, a1b, m1, h1, h1bare, hm } = rows;
      expect((await listSnapshots(owner.client, { "account-id": `n${n}-a1` })).json).toEqual({
        status: "success",
        body: [...byId([accountJson(a1), accountJson(a1b), accountJson(m1)]), ...byId([holdingJson(h1), holdingJson(h1bare), holdingJson(hm)])],
      });
      expect((await listSnapshots(owner.client, { "account-id": `n${n}-a1`, "snapshot-type": "account_balance" })).body).toEqual(
        byId([accountJson(a1), accountJson(a1b), accountJson(m1)]),
      );
      expect((await listSnapshots(owner.client, { "account-id": `n${n}-a1`, "snapshot-type": "holding" })).body).toEqual(
        byId([holdingJson(h1), holdingJson(h1bare), holdingJson(hm)]),
      );
      expect((await listSnapshots(owner.client, { "account-id": `n${n}-a1`, "snapshot-type": "security" })).body).toEqual([]);
      // An account nobody has, and an empty one, which narrows nothing.
      expect((await listSnapshots(owner.client, { "account-id": `n${n}-none` })).body).toEqual([]);
      const all = (await listSnapshots(owner.client)).body;
      expect((await listSnapshots(owner.client, { "account-id": "" })).body).toEqual(all);
    });

    test("to a security: the caller's rows naming it, its holdings in an account, and its prices", async () => {
      const { withSecurity, h1, hm } = rows;
      const bareSnapshots = SECURITY_SNAPSHOTS.filter((s) => (s as { security: { security_id: string } }).security.security_id === BARE.security_id);
      expect((await listSnapshots(owner.client, { "security-id": BARE.security_id })).json).toEqual({
        status: "success",
        body: [accountJson(withSecurity), ...bareSnapshots],
      });
      // With an account, the holding read takes the security from `holding_security_id`.
      expect((await listSnapshots(owner.client, { "security-id": PRICED.security_id, "account-id": `n${n}-a1` })).body).toEqual(
        byId([holdingJson(h1), holdingJson(hm)]),
      );
      expect((await listSnapshots(owner.client, { "security-id": "no-such-security" })).body).toEqual([]);
    });

    test("to a type", async () => {
      const { a1, a1b, a2, m1, h1, h1bare, h2, hm, withSecurity } = rows;
      expect((await listSnapshots(owner.client, { "snapshot-type": "account_balance" })).body).toEqual(
        byId([a1, a1b, a2, m1, withSecurity].map(accountJson)),
      );
      expect((await listSnapshots(owner.client, { "snapshot-type": "holding" })).body).toEqual(byId([h1, h1bare, h2, hm].map(holdingJson)));
      expect((await listSnapshots(owner.client, { "snapshot-type": "security" })).body).toEqual(SECURITY_SNAPSHOTS);
      expect((await listSnapshots(member.client, { "snapshot-type": "security", "security-id": PRICED.security_id })).body).toEqual(
        SECURITY_SNAPSHOTS.filter((s) => (s as { security: { security_id: string } }).security.security_id === PRICED.security_id),
      );
    });

    test("to a range of when rows were last written, prices included", async () => {
      const { a1, a1b, a2, m1, h1, h1bare, h2, hm, withSecurity } = rows;
      const own = byId([...[a1, a1b, a2, m1, withSecurity].map(accountJson), ...[h1, h1bare, h2, hm].map(holdingJson)]);
      // One row written later than the rest. Every bound is a day or more
      // from a stamp, so the zone a bare date is read in decides nothing.
      await stampAll([a2.snapshot_id], "2026-02-15T12:00:00Z");
      const later = own.filter((s) => s.snapshot.snapshot_id === a2.snapshot_id);
      const earlier = own.filter((s) => s.snapshot.snapshot_id !== a2.snapshot_id);
      const cases: [Record<string, string>, unknown[]][] = [
        [{ "start-date": "2026-01-01" }, [...own, ...SECURITY_SNAPSHOTS]],
        [{ "start-date": "2026-01-12" }, later],
        [{ "start-date": "2026-02-15T12:00:00Z" }, later],
        [{ "start-date": "2026-02-15T12:00:01Z" }, []],
        [{ "end-date": "2026-01-10T12:00:00Z" }, [...earlier, ...SECURITY_SNAPSHOTS]],
        [{ "end-date": "2026-01-10T11:59:59.999Z" }, []],
        [{ "end-date": "2026-01-09" }, []],
        [{ "start-date": "2026-01-09", "end-date": "2026-01-31" }, [...earlier, ...SECURITY_SNAPSHOTS]],
        [{ "start-date": "2026-02-01", "end-date": "2026-02-28T23:59:59" }, later],
        [{ "start-date": "2026-03-01", "end-date": "2026-02-01" }, []],
        [{ "start-date": "", "end-date": "" }, [...own, ...SECURITY_SNAPSHOTS]],
        [{ "start-date": "2026-01-12", "account-id": `n${n}-a2` }, later],
      ];
      for (const [query, body] of cases) {
        const result = await listSnapshots(owner.client, query);
        expect([query, result.json]).toEqual([query, { status: "success", body }]);
      }
    });
  });

  test("refuses a malformed query with the first problem it finds", async () => {
    const owner = await person("bad-query");
    const cases: [string, string][] = [
      ["?start-date=a&start-date=b", "Parameter start-date must be a single value, not an array"],
      ["?end-date=2026-01-01&end-date=2026-01-02", "Parameter end-date must be a single value, not an array"],
      ["?start-date=yesterday", "Field start-date must be a date"],
      ["?start-date=%20", "Field start-date must be a date"],
      ["?start-date=2026-02-30", "Field start-date must be a date"],
      ["?start-date=2026-13-01", "Field start-date must be a date"],
      ["?start-date=2026-1-01", "Field start-date must be a date"],
      ["?start-date=20260101", "Field start-date must be a date"],
      ["?start-date=2026-01-01Tnoon", "Field start-date must be a date"],
      ["?start-date=2026-01-01&end-date=2025-02-29", "Field end-date must be a date"],
      ["?end-date=Jan%201%2C%202026", "Field end-date must be a date"],
      // The dates are checked before the other parameters are read.
      ["?snapshot-type=bad&start-date=bad", "Field start-date must be a date"],
      ["?account-id=a&account-id=b", "Parameter account-id must be a single value, not an array"],
      ["?account-id=a&account-id=b&security-id=c&security-id=d", "Parameter account-id must be a single value, not an array"],
      ["?security-id=c&security-id=d", "Parameter security-id must be a single value, not an array"],
      ["?snapshot-type=a&snapshot-type=b", "Parameter snapshot-type must be a single value, not an array"],
      ["?snapshot-type=bad", "snapshot-type must be one of: account_balance, holding, security"],
      ["?snapshot-type=Holding", "snapshot-type must be one of: account_balance, holding, security"],
      ["?snapshot-type=%20holding", "snapshot-type must be one of: account_balance, holding, security"],
      ["?snapshot-type=account", "snapshot-type must be one of: account_balance, holding, security"],
    ];
    for (const [query, message] of cases) {
      const result = await owner.client.get(`/snapshots${query}`);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
    // An empty type narrows nothing.
    expect((await owner.client.get("/snapshots?snapshot-type=")).json).toEqual({ status: "success", body: SECURITY_SNAPSHOTS });
  });
});

// ---------------------------------------------------------------------------
// POST /snapshot
// ---------------------------------------------------------------------------

describe("POST /snapshot", () => {
  /** A person with an account of their own. */
  const withAccount = async (name: string): Promise<Person & { account_id: string }> => {
    const owner = await person(name);
    const account_id = await seedAccount(stack, owner.user_id, `${name}-acc-${counter}`);
    return { ...owner, account_id };
  };

  const storedSnapshot = async (snapshot_id: string) => withoutStamps(await storedRow(stack, "snapshots", snapshot_id));

  /** The row a balance snapshot is stored as. */
  const balanceRow = (fields: { snapshot_id: string; user_id: string; account_id: string; date: string } & Partial<Record<"current" | "available" | "limit" | "iso_currency_code", unknown>>): StoredRow => ({
    snapshot_id: fields.snapshot_id,
    user_id: fields.user_id,
    snapshot_date: expect.any(String),
    snapshot_type: "account_balance",
    account_id: fields.account_id,
    balances_available: fields.available ?? null,
    balances_current: fields.current ?? null,
    balances_limit: fields.limit ?? null,
    balances_iso_currency_code: fields.iso_currency_code ?? null,
    security_id: null,
    close_price: null,
    holding_account_id: null,
    holding_security_id: null,
    institution_price: null,
    institution_value: null,
    cost_basis: null,
    quantity: null,
    is_deleted: false,
  });

  const expectStoredDate = async (snapshot_id: string, date: string) => {
    const row = await storedRow(stack, "snapshots", snapshot_id);
    expect(new Date(row!.snapshot_date as string).toISOString()).toBe(date);
  };

  test("records today's balances of the caller's account, and answers the id and the date stored", async () => {
    const owner = await withAccount("poster");
    const balances = { current: 1234.56, available: 1000.5, limit: 5000, iso_currency_code: "USD", unofficial_currency_code: "ignored" };
    const result = await owner.client.post<{ snapshot_id: string; date: string }>("/snapshot", {
      snapshot: {},
      account: { account_id: owner.account_id, name: "ignored", balances },
    });
    expect(result.status).toBe(200);
    const snapshot_id = `${owner.account_id}-${squashedDay(new Date())}`;
    expect(result.json).toEqual({ status: "success", body: { snapshot_id, date: expect.stringMatching(ISO) } });
    expect(Math.abs(Date.parse(result.body.date) - Date.now())).toBeLessThan(60_000);
    expect(await storedSnapshot(snapshot_id)).toEqual(balanceRow({ snapshot_id, user_id: owner.user_id, account_id: owner.account_id, date: result.body.date, ...balances }));
    await expectStoredDate(snapshot_id, result.body.date);
    // It is listed back as it was answered.
    expect((await listSnapshots(owner.client, { "account-id": owner.account_id })).body).toEqual([
      {
        snapshot: { snapshot_id, date: result.body.date, is_deleted: false },
        user: { user_id: owner.user_id },
        account: { account_id: owner.account_id, balances: { current: 1234.56, available: 1000.5, limit: 5000, iso_currency_code: "USD", unofficial_currency_code: null } },
      },
    ]);
  });

  test("files the snapshot under the day the date falls on in the server's zone", async () => {
    const owner = await withAccount("dated");
    const cases: [unknown, Date][] = [
      ["2026-03-15", localMidnight("2026-03-15")],
      ["2026-03-15T12:30:00Z", new Date("2026-03-15T12:30:00Z")],
      ["2026-03-15T23:30:00-05:00", new Date("2026-03-15T23:30:00-05:00")],
      ["2026-03-16T00:15:00", new Date("2026-03-16T00:15:00")],
      ["2024-02-29", localMidnight("2024-02-29")],
      ["1999-12-31T23:59:59.999Z", new Date("1999-12-31T23:59:59.999Z")],
    ];
    for (const [date, expected] of cases) {
      const result = await owner.client.post("/snapshot", { snapshot: { date }, account: { account_id: owner.account_id, balances: { current: 1 } } });
      const snapshot_id = `${owner.account_id}-${squashedDay(expected)}`;
      expect([date, result.json]).toEqual([date, { status: "success", body: { snapshot_id, date: expected.toISOString() } }]);
      await expectStoredDate(snapshot_id, expected.toISOString());
    }
    // Absent, null and empty dates are today.
    for (const snapshot of [{}, { date: null }, { date: "" }]) {
      const result = await owner.client.post<{ snapshot_id: string; date: string }>("/snapshot", { snapshot, account: { account_id: owner.account_id } });
      expect(result.json).toEqual({ status: "success", body: { snapshot_id: `${owner.account_id}-${squashedDay(new Date())}`, date: expect.stringMatching(ISO) } });
    }
  });

  test("refuses a date that is not a date string, before writing anything", async () => {
    const owner = await withAccount("bad-date");
    const cases: [unknown, string][] = [
      [5, "snapshot.date must be a string"],
      [0, "snapshot.date must be a string"],
      [true, "snapshot.date must be a string"],
      [false, "snapshot.date must be a string"],
      [[], "snapshot.date must be a string"],
      [{}, "snapshot.date must be a string"],
      ["yesterday", "snapshot.date is not a valid date"],
      [" ", "snapshot.date is not a valid date"],
      ["2026-13-01", "snapshot.date is not a valid date"],
      ["2026-03-15Tnoon", "snapshot.date is not a valid date"],
    ];
    for (const [date, message] of cases) {
      const result = await owner.client.post("/snapshot", { snapshot: { date }, account: { account_id: owner.account_id } });
      expect([date, result.json]).toEqual([date, failed(message)]);
    }
    expect(await storedRows(stack, "snapshots", { account_id: owner.account_id })).toEqual([]);
  });

  test("reads other date strings as the runtime reads them", async () => {
    const owner = await withAccount("odd-date");
    for (const date of ["2026-02-30", "2026-02-29", "2026/03/15", "March 15, 2026", "15 Mar 2026 10:00 GMT", "2026-03-15 10:00", "2026-03-15T25:00:00", "+002026-03-15T00:00:00Z", "2026-03", "2026"]) {
      const result = await owner.client.post<{ snapshot_id: string; date: string }>("/snapshot", { snapshot: { date }, account: { account_id: owner.account_id } });
      const expected = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : date);
      const answer = Number.isNaN(expected.getTime())
        ? failed("snapshot.date is not a valid date")
        : { status: "success", body: { snapshot_id: `${owner.account_id}-${squashedDay(expected)}`, date: expected.toISOString() } };
      expect([date, result.json]).toEqual([date, answer]);
    }
  });

  test("refuses a body without snapshot data or an account id, before looking anything up", async () => {
    const owner = await withAccount("bad-body");
    const account = { account_id: owner.account_id };
    const cases: [unknown, string][] = [
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      [[{ snapshot: {}, account }], "Request body must be an object"],
      ["text", "Request body must be an object"],
      [5, "Request body must be an object"],
      [true, "Request body must be an object"],
      [{}, "Request body must contain snapshot data"],
      [{ account }, "Request body must contain snapshot data"],
      ...[null, false, 0, "", "snapshot", 5, true, [], [{}]].map((snapshot): [unknown, string] => [{ snapshot, account }, "Request body must contain snapshot data"]),
      [{ snapshot: {} }, "Request body must contain an account with an account_id"],
      ...[null, false, 0, "", owner.account_id, 5, true, [], [account], {}, { account_id: null }, { account_id: 5 }, { account_id: true }, { account_id: [owner.account_id] }, { account_id: {} }, { id: owner.account_id }].map(
        (badAccount): [unknown, string] => [{ snapshot: {}, account: badAccount }, "Request body must contain an account with an account_id"],
      ),
      // The account is checked before the snapshot's date.
      [{ snapshot: { date: 5 }, account: {} }, "Request body must contain an account with an account_id"],
    ];
    for (const [body, message] of cases) {
      const result = await owner.client.post("/snapshot", body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    // No body at all, and one that is not JSON.
    expect((await owner.client.request("POST", "/snapshot")).json).toEqual(failed("Request body is required"));
    expect((await owner.client.request("POST", "/snapshot", { rawBody: "{not json", headers: { "Content-Type": "application/json" } })).json).toEqual(
      failed("Request body is required"),
    );
    expect(await storedRows(stack, "snapshots", { account_id: owner.account_id })).toEqual([]);
  });

  test("checks each balance's type and bound before the account is looked up", async () => {
    const owner = await person("bad-balances");
    const balancesOf = (balances: unknown) => ({ snapshot: {}, account: { account_id: "no-such-account", balances } });
    const missing = failed("Account not found or access denied.");
    const cases: [unknown, unknown][] = [
      [5, failed("Field balances must be an object")],
      ["x", failed("Field balances must be an object")],
      [true, failed("Field balances must be an object")],
      [[], failed("Field balances must be an object")],
      [[1], failed("Field balances must be an object")],
      [null, missing],
      [{}, missing],
    ];
    for (const field of ["available", "current", "limit"]) {
      const path = `account.balances.${field}`;
      cases.push(
        [{ [field]: "1" }, failed(`Field ${path} must be a number`)],
        [{ [field]: "" }, failed(`Field ${path} must be a number`)],
        [{ [field]: true }, failed(`Field ${path} must be a number`)],
        [{ [field]: [] }, failed(`Field ${path} must be a number`)],
        [{ [field]: {} }, failed(`Field ${path} must be a number`)],
        [{ [field]: 1e13 }, failed(`Field ${path} must be at most 9999999999999.99`)],
        [{ [field]: -1e13 }, failed(`Field ${path} must be at most 9999999999999.99`)],
        [{ [field]: 10000000000000 }, failed(`Field ${path} must be at most 9999999999999.99`)],
        [{ [field]: 9999999999999.99 }, missing],
        [{ [field]: -9999999999999.99 }, missing],
        [{ [field]: 0 }, missing],
        [{ [field]: null }, missing],
      );
    }
    const code = "account.balances.iso_currency_code";
    cases.push(
      [{ iso_currency_code: 5 }, failed(`Field ${code} must be a string`)],
      [{ iso_currency_code: true }, failed(`Field ${code} must be a string`)],
      [{ iso_currency_code: ["USD"] }, failed(`Field ${code} must be a string`)],
      [{ iso_currency_code: "ABCDEFGHIJK" }, failed(`Field ${code} must be at most 10 characters`)],
      [{ iso_currency_code: "ÉÉÉÉÉÉÉÉÉÉÉ" }, failed(`Field ${code} must be at most 10 characters`)],
      // Ten characters as JavaScript counts them: one astral character counts as two.
      [{ iso_currency_code: "😀😀😀😀😀😀" }, failed(`Field ${code} must be at most 10 characters`)],
      [{ iso_currency_code: "😀😀😀😀😀" }, missing],
      [{ iso_currency_code: "ABCDEFGHIJ" }, missing],
      [{ iso_currency_code: "" }, missing],
      [{ iso_currency_code: null }, missing],
      // The first field in the spec's order is the one named.
      [{ iso_currency_code: 5, limit: "x", current: "x", available: "x" }, failed("Field account.balances.available must be a number")],
      [{ iso_currency_code: 5, limit: "x", current: "x" }, failed("Field account.balances.current must be a number")],
      [{ iso_currency_code: 5, limit: "x" }, failed("Field account.balances.limit must be a number")],
    );
    for (const [balances, answer] of cases) {
      const result = await owner.client.post("/snapshot", balancesOf(balances));
      expect([balances, result.json]).toEqual([balances, answer]);
    }
    // Not covered: a body number past the float range (`1e999`). Bun parses
    // it as Infinity and answers "must be a number"; the Rust server's JSON
    // values cannot hold a non-finite number, so it reads no body at all.
  });

  test("writes only the balances given, and an update keeps the ones left out", async () => {
    const owner = await withAccount("partial");
    const snapshot_id = `${owner.account_id}-20260320`;
    const post = (balances?: unknown) =>
      owner.client.post("/snapshot", { snapshot: { date: "2026-03-20" }, account: { account_id: owner.account_id, ...(balances === undefined ? {} : { balances }) } });
    expect((await post()).json).toEqual({ status: "success", body: { snapshot_id, date: localMidnight("2026-03-20").toISOString() } });
    expect(await storedSnapshot(snapshot_id)).toEqual(balanceRow({ snapshot_id, user_id: owner.user_id, account_id: owner.account_id, date: "" }));

    await post({ current: 10, available: 9, limit: 8, iso_currency_code: "EUR" });
    expect(await storedSnapshot(snapshot_id)).toEqual(balanceRow({ snapshot_id, user_id: owner.user_id, account_id: owner.account_id, date: "", current: 10, available: 9, limit: 8, iso_currency_code: "EUR" }));
    // Only `current` given: the rest stay as they were.
    await post({ current: -0.01 });
    expect(await storedSnapshot(snapshot_id)).toEqual(balanceRow({ snapshot_id, user_id: owner.user_id, account_id: owner.account_id, date: "", current: -0.01, available: 9, limit: 8, iso_currency_code: "EUR" }));
    // Explicit nulls clear.
    await post({ available: null, limit: null, iso_currency_code: null });
    expect(await storedSnapshot(snapshot_id)).toEqual(balanceRow({ snapshot_id, user_id: owner.user_id, account_id: owner.account_id, date: "", current: -0.01 }));
    // Amounts are rounded to the column's two decimals.
    await post({ current: 1.005, available: 2.444999 });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ balances_current: 1.01, balances_available: 2.44 });
    expect(await storedRows(stack, "snapshots", { account_id: owner.account_id })).toHaveLength(1);
  });

  test("brings a deleted snapshot of the same day back", async () => {
    const owner = await withAccount("revive");
    const snapshot_id = `${owner.account_id}-20260321`;
    await owner.client.post("/snapshot", { snapshot: { date: "2026-03-21" }, account: { account_id: owner.account_id, balances: { current: 1 } } });
    expect((await owner.client.delete(`/snapshot?id=${snapshot_id}`)).json).toEqual(SUCCESS);
    expect((await storedRow(stack, "snapshots", snapshot_id))?.is_deleted).toBe(true);
    await owner.client.post("/snapshot", { snapshot: { date: "2026-03-21" }, account: { account_id: owner.account_id, balances: { current: 2 } } });
    expect(await storedSnapshot(snapshot_id)).toEqual(balanceRow({ snapshot_id, user_id: owner.user_id, account_id: owner.account_id, date: "", current: 2 }));
  });

  test("writes a member's account snapshot as the member's, and refuses an account that is missing, deleted or a stranger's", async () => {
    const [owner, member, stranger] = [await withAccount("group-owner"), await withAccount("group-member"), await withAccount("group-stranger")];
    await shareData(stack, owner.user_id, member.user_id);
    const deleted = await seedAccount(stack, owner.user_id, `deleted-acc-${counter}`);
    await softDelete(stack, "accounts", deleted);

    const result = await owner.client.post("/snapshot", { snapshot: { date: "2026-04-01" }, account: { account_id: member.account_id, balances: { current: 5 } } });
    const snapshot_id = `${member.account_id}-20260401`;
    expect(result.json).toEqual({ status: "success", body: { snapshot_id, date: localMidnight("2026-04-01").toISOString() } });
    expect(await storedSnapshot(snapshot_id)).toEqual(balanceRow({ snapshot_id, user_id: member.user_id, account_id: member.account_id, date: "", current: 5 }));
    // The member's own edit of it keeps the owner.
    await member.client.post("/snapshot", { snapshot: { date: "2026-04-01" }, account: { account_id: member.account_id, balances: { current: 6 } } });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ user_id: member.user_id, balances_current: 6 });

    for (const account_id of [stranger.account_id, deleted, "no-such-account", ""]) {
      const refused = await owner.client.post("/snapshot", { snapshot: { date: 5 }, account: { account_id, balances: { current: 1 } } });
      expect([account_id, refused.json]).toEqual([account_id, failed("Account not found or access denied.")]);
    }
    expect(await storedRows(stack, "snapshots", { account_id: stranger.account_id })).toEqual([]);
    expect(await storedRows(stack, "snapshots", { account_id: deleted })).toEqual([]);
  });

  test("answers the id even when the write fails", async () => {
    // An account id at the column's limit leaves no room for the date in the snapshot id.
    const owner = await person("long-id");
    const account_id = await seedAccount(stack, owner.user_id, `long-${"x".repeat(250)}`, { item_id: "item-long", institution_id: "ins-long", name: "Long" });
    const result = await owner.client.post("/snapshot", { snapshot: { date: "2026-04-02" }, account: { account_id, balances: { current: 1 } } });
    expect(result.json).toEqual({ status: "success", body: { snapshot_id: `${account_id}-20260402`, date: localMidnight("2026-04-02").toISOString() } });
    expect(await storedRows(stack, "snapshots", { account_id })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /snapshot
// ---------------------------------------------------------------------------

describe("DELETE /snapshot", () => {
  test("soft-deletes the caller's snapshot of any type, and a member's", async () => {
    const [owner, member] = [await person("deleter"), await person("deleter-member")];
    await shareData(stack, owner.user_id, member.user_id);
    const n = counter;
    const mine = await seedAccountRow({ snapshot_id: `d${n}-acc-20260101`, user_id: owner.user_id, account_id: `d${n}-acc`, snapshot_date: "2026-01-01T00:00:00Z", current: 1 });
    const holding = await seedHoldingRow({ snapshot_id: `holding-d${n}-20260101`, user_id: owner.user_id, snapshot_date: "2026-01-01T00:00:00Z", holding_account_id: `d${n}-acc`, holding_security_id: BARE.security_id, quantity: 1 });
    const theirs = await seedAccountRow({ snapshot_id: `d${n}-macc-20260101`, user_id: member.user_id, account_id: `d${n}-macc`, snapshot_date: "2026-01-01T00:00:00Z" });
    await stampAll([mine, holding, theirs]);
    for (const snapshot_id of [mine, holding, theirs]) {
      const result = await owner.client.delete(`/snapshot?id=${encodeURIComponent(snapshot_id)}`);
      expect([snapshot_id, result.status, result.json]).toEqual([snapshot_id, 200, SUCCESS]);
      const row = await storedRow(stack, "snapshots", snapshot_id);
      expect(row?.is_deleted).toBe(true);
      expect(Date.parse(row!.updated as string)).toBeGreaterThan(Date.parse(SEEDED_AT));
    }
    // A deleted snapshot is still found, and deleting it again succeeds.
    expect((await member.client.delete(`/snapshot?id=${mine}`)).json).toEqual(SUCCESS);
    // The list carries them as tombstones.
    const listed = (await listSnapshots(owner.client, { "account-id": `d${n}-acc` })).body as { snapshot: { snapshot_id: string; is_deleted: boolean } }[];
    expect(listed.map((s) => [s.snapshot.snapshot_id, s.snapshot.is_deleted])).toEqual([
      [mine, true],
      [holding, true],
    ]);
  });

  test("refuses a snapshot that is missing, a stranger's, or a security price", async () => {
    const [owner, stranger] = [await person("deleter-refused"), await person("deleter-stranger")];
    const theirs = await seedAccountRow({ snapshot_id: `ds${counter}-acc-20260101`, user_id: stranger.user_id, account_id: `ds${counter}-acc`, snapshot_date: "2026-01-01T00:00:00Z" });
    for (const snapshot_id of [theirs, "no-such-snapshot", "snap-sec-priced-20260105"]) {
      const result = await owner.client.delete(`/snapshot?id=${snapshot_id}`);
      expect([snapshot_id, result.json]).toEqual([snapshot_id, failed("Snapshot not found.")]);
    }
    expect((await storedRow(stack, "snapshots", theirs))?.is_deleted).toBe(false);
    expect((await storedRow(stack, "snapshots", "snap-sec-priced-20260105"))?.is_deleted).toBe(false);
  });

  test("answers that it found nothing when the delete touches no row, and fails as a server error when it fails", async () => {
    const owner = await person("deleter-broken");
    const snapshot_id = await seedAccountRow({ snapshot_id: `db${counter}-acc-20260101`, user_id: owner.user_id, account_id: `db${counter}-acc`, snapshot_date: "2026-01-01T00:00:00Z" });
    const when = `NEW.snapshot_id = '${snapshot_id}'`;
    await withWritesBroken(stack, "snapshots", { event: "UPDATE", when, mode: "skip" }, async () => {
      expect((await owner.client.delete(`/snapshot?id=${snapshot_id}`)).json).toEqual(failed("Snapshot not found."));
    });
    await withWritesBroken(stack, "snapshots", { event: "UPDATE", when, mode: "raise" }, async () => {
      const result = await owner.client.delete(`/snapshot?id=${snapshot_id}`);
      expect(result.status).toBe(500);
      expect(result.json).toEqual({ status: "error", message: "Internal server error" });
    });
    const { discord } = stack.upstream;
    const title = "🚨 Budget Server Error: Route Error: DELETE /snapshot";
    await stack.waitFor(() => discord.alarms().some((alarm) => alarm.title === title), { what: "the route error alarm" });
    expect(discord.alarms().find((alarm) => alarm.title === title)?.description).toBe("**Error:** conformance: refused");
    expect((await storedRow(stack, "snapshots", snapshot_id))?.is_deleted).toBe(false);
  });

  test("needs one id", async () => {
    const owner = await person("deleter-query");
    const cases: [string, string][] = [
      ["", "Missing required parameter: id"],
      ["?ID=x", "Missing required parameter: id"],
      ["?id[]=x", "Missing required parameter: id"],
      ["?id=a&id=b", "Parameter id must be a single value, not an array"],
      ["?id=&id=", "Parameter id must be a single value, not an array"],
      ["?id", "Parameter id cannot be empty"],
      ["?id=", "Parameter id cannot be empty"],
      ["?id=%20%09", "Parameter id cannot be empty"],
      ["?id=%C2%A0%EF%BB%BF", "Parameter id cannot be empty"],
      ["?id=%C2%85", "Snapshot not found."],
    ];
    for (const [query, message] of cases) {
      const result = await owner.client.delete(`/snapshot${query}`);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
  });
});
