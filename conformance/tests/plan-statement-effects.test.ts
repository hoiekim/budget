/**
 * What a plan-statement import, `POST /plan-statement/import`, does beside
 * storing its rows: the fund mappings it saves on the account, the holdings
 * rows it writes, the entered positions it retires, the change events it
 * sends, the monthly price backfill it starts, and how all of it is undone
 * when one write fails. The request's checks and the rows themselves are in
 * `plan-statement.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startStack, urlsOf, type Stack } from "../harness";
import { polygonAnswer } from "../harness/upstreams/polygon";
import { yahooAnswer } from "../harness/upstreams/yahoo";
import { rowOf, rowsOf, seedHolding, seedHoldingSnapshot, seedInvestmentTransaction, shareData, softDeleteRow, uniqueId, type StoredRow } from "../harness/seed/accounts";
import {
  cashLeg,
  cashSecurity,
  fundSecurity,
  importBody,
  importPlanStatement as post,
  planAccount,
  planPerson,
  savedMappings,
  shareLeg,
  storedHolding,
  uniqueTicker as ticker,
  withoutStamps,
  type ImportBody,
} from "../harness/seed/plan-statement";
import { localDay, squashedDay, storedSecuritySnapshots, withWritesBroken } from "../harness/seed/snapshots";
import { openEventStream, type EventStream } from "../harness/sse";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const streams: EventStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
});

const ROUTE = "POST /plan-statement/import";
const POLYGON_KEY = "conformance-polygon-key";
const DAY = 86_400_000;
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const success = (body: Record<string, unknown>) => ({ status: "success", body });
const NOTHING_WRITTEN = success({ written: 0, alreadyImported: 0 });

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

const person = (name: string) => planPerson(stack, name);
const mappingsOf = (account_id: string) => savedMappings(stack, account_id);
const storedRows = async (table: string, where: Record<string, unknown>) => (await rowsOf(stack, table, where)).map(withoutStamps);

type Listed = { accounts: { account_id: string; plan_fund_mappings?: unknown }[] };
const listedMappings = async (client: Parameters<typeof post>[0], account_id: string) =>
  (await client.get<Listed>("/accounts")).body.accounts.find((a) => a.account_id === account_id)?.plan_fund_mappings;

// ---------------------------------------------------------------------------
// Mappings, replaced positions and holdings
// ---------------------------------------------------------------------------

describe("the fund mappings", () => {
  test("are saved on the account over the ones it had, keeping those the statement does not name, and list back", async () => {
    const owner = await person("mappings");
    const [one, two, three] = [await cashSecurity(stack), await cashSecurity(stack), await cashSecurity(stack)];
    // What a saved mapping holds besides its security and restatement is not kept, and a missing part stays missing.
    await stack.db.query("UPDATE accounts SET plan_fund_mappings = $1 WHERE account_id = $2", [
      { "Old Fund": { security_id: one, restated: true, extra: 1 }, Bare: { security_id: two }, Kept: { security_id: three, restated: false } },
      owner.account_id,
    ]);
    const body = importBody(owner.account_id, [], {
      mappings: [
        { investment: "Old Fund", security_id: two, restated: false, extra: 2 },
        { investment: "New Fund", security_id: one, restated: true },
        { investment: "401", security_id: three, restated: false },
        // A fund named twice: the later mapping is the one saved.
        { investment: "New Fund", security_id: three, restated: false },
      ],
    });
    expect((await post(owner.client, body)).json).toEqual(NOTHING_WRITTEN);
    expect(await mappingsOf(owner.account_id)).toEqual({
      "Old Fund": { security_id: two, restated: false },
      Bare: { security_id: two },
      Kept: { security_id: three, restated: false },
      "New Fund": { security_id: three, restated: false },
      "401": { security_id: three, restated: false },
    });
    expect(await listedMappings(owner.client, owner.account_id)).toEqual([
      { investment: "401", security_id: three, restated: false },
      { investment: "Bare", security_id: two },
      { investment: "Kept", security_id: three, restated: false },
      { investment: "New Fund", security_id: three, restated: false },
      { investment: "Old Fund", security_id: two, restated: false },
    ]);
    // With none given, the saved ones stay as they are.
    expect((await post(owner.client, importBody(owner.account_id, []))).json).toEqual(NOTHING_WRITTEN);
    expect(Object.keys((await mappingsOf(owner.account_id)) as object)).toHaveLength(5);
  });

  test("of an account that had none are an empty set when the statement names none", async () => {
    const owner = await person("nomappings");
    expect((await post(owner.client, importBody(owner.account_id, []))).json).toEqual(NOTHING_WRITTEN);
    expect(await mappingsOf(owner.account_id)).toEqual({});
    expect(await listedMappings(owner.client, owner.account_id)).toEqual([]);
  });
});

describe("the holdings", () => {
  test("take each position the statement leaves, over the holdings row there was", async () => {
    const owner = await person("holdings");
    const [one, two, three] = [await cashSecurity(stack), await cashSecurity(stack), await cashSecurity(stack)];
    await seedHolding(stack, owner.user_id, owner.account_id, one, { quantity: "99", institution_value: "1" });
    const holdings = [
      { security_id: one, date: "2026-03-02", quantity: 20.5, cost_basis: 1000.25, price: 50.123456 },
      { security_id: two, date: "2024-02-29", quantity: 0, cost_basis: null, price: 0 },
      { security_id: three, date: "2026-01-31", quantity: -3, cost_basis: -1, price: 0.1 },
      // A security twice: the later position is the one kept.
      { security_id: two, date: "2026-03-03", quantity: 7, cost_basis: 70, price: 10 },
    ];
    expect((await post(owner.client, importBody(owner.account_id, [], { holdings }))).json).toEqual(NOTHING_WRITTEN);
    const byId = (x: StoredRow | undefined, y: StoredRow | undefined) => (String(x?.holding_id) < String(y?.holding_id) ? -1 : 1);
    expect((await storedRows("holdings", { account_id: owner.account_id })).sort(byId)).toEqual(
      [
        storedHolding(owner.user_id, owner.account_id, holdings[0], { institution_value: 1027.53 }),
        storedHolding(owner.user_id, owner.account_id, holdings[3]),
        storedHolding(owner.user_id, owner.account_id, holdings[2], { institution_value: -0.3 }),
      ].sort(byId),
    );
  });
});

describe("the entered positions", () => {
  test("of the securities the statement replaces are retired in this account, and no others", async () => {
    const owner = await person("replace");
    const other = await planAccount(stack, owner.user_id, owner.item_id);
    const [replaced, kept, unheld] = [await cashSecurity(stack), await cashSecurity(stack), await cashSecurity(stack)];
    const seeded = {
      first: await seedHoldingSnapshot(stack, owner.user_id, owner.account_id, replaced, { snapshot_date: "2026-01-02" }),
      second: await seedHoldingSnapshot(stack, owner.user_id, owner.account_id, replaced, { snapshot_date: "2026-02-02" }),
      kept: await seedHoldingSnapshot(stack, owner.user_id, owner.account_id, kept),
      otherAccount: await seedHoldingSnapshot(stack, owner.user_id, other, replaced),
      balance: uniqueId("snap-balance"),
    };
    await stack.db.insert("snapshots", {
      snapshot_id: seeded.balance,
      user_id: owner.user_id,
      snapshot_date: "2026-03-04",
      snapshot_type: "account_balance",
      account_id: owner.account_id,
      balances_current: "1",
    });
    const flags = async () => {
      const out: Record<string, unknown> = {};
      for (const [name, id] of Object.entries(seeded)) out[name] = (await rowOf(stack, "snapshots", id))?.is_deleted;
      return out;
    };
    // Without a replacement, or with one of a security nothing was entered for, nothing is retired.
    for (const extra of [{}, { replace: null }, { replace: [] }, { replace: [unheld] }]) {
      expect((await post(owner.client, importBody(owner.account_id, [], extra))).json).toEqual(NOTHING_WRITTEN);
    }
    expect(await flags()).toEqual({ first: false, second: false, kept: false, otherAccount: false, balance: false });
    expect((await post(owner.client, importBody(owner.account_id, [], { replace: [replaced, unheld, replaced] }))).json).toEqual(NOTHING_WRITTEN);
    expect(await flags()).toEqual({ first: true, second: true, kept: false, otherAccount: false, balance: false });
  });

  test("of an account someone in the sharing group owns are retired as that owner's", async () => {
    const [caller, owner] = [await person("replace-caller"), await person("replace-owner")];
    await shareData(stack, caller.user_id, owner.user_id);
    const security_id = await cashSecurity(stack);
    // One entered by the owner, one by the caller on the owner's account.
    const byOwner = await seedHoldingSnapshot(stack, owner.user_id, owner.account_id, security_id);
    const byCaller = await seedHoldingSnapshot(stack, caller.user_id, owner.account_id, security_id);
    expect((await post(caller.client, importBody(owner.account_id, [], { replace: [security_id] }))).json).toEqual(NOTHING_WRITTEN);
    expect([(await rowOf(stack, "snapshots", byOwner))?.is_deleted, (await rowOf(stack, "snapshots", byCaller))?.is_deleted]).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

describe("the change events", () => {
  /**
   * The Bun server looks each event's sharing group up on its own, so the
   * three events can arrive in either order: they are read as a set, and the
   * streams are kept out of the comparison.
   */
  const threeEvents = async (stream: EventStream) => {
    const events = [await stream.nextEvent(), await stream.nextEvent(), await stream.nextEvent()];
    return events.sort((x, y) => (x.event < y.event ? -1 : 1));
  };

  test("tell the writing tab about the rows, and every tab of the group about the account and its snapshots", async () => {
    const [owner, member] = [await person("events"), await person("events-member")];
    await shareData(stack, owner.user_id, member.user_id);
    const security_id = await cashSecurity(stack);
    const mine = await openEventStream(owner.client, { noCompare: true });
    const theirs = await openEventStream(member.client, { noCompare: true });
    streams.push(mine, theirs);
    const ids = [(await mine.next((b) => b.event === "connected")).id, (await theirs.next((b) => b.event === "connected")).id].map(Number);
    const body = importBody(owner.account_id, [shareLeg(owner.account_id, security_id)]);
    expect((await post(owner.client, body, { headers: { "X-Tab-Id": "import-tab" } })).json).toEqual(success({ written: 1, alreadyImported: 0 }));
    for (const [stream, id] of [
      [mine, ids[0]],
      [theirs, ids[1]],
    ] as const) {
      const events = await threeEvents(stream);
      expect(events.map((e) => [e.event, e.data])).toEqual([
        ["accounts-updated", {}],
        ["investment_transactions-updated", { originTabId: "import-tab" }],
        ["snapshots-updated", {}],
      ]);
      expect(events.map((e) => Number(e.id)).sort()).toEqual([id + 1, id + 2, id + 3]);
    }
  });

  test("follow an answer naming deleted rows too, and no refusal", async () => {
    const owner = await person("events-deleted");
    const security_id = await cashSecurity(stack);
    const stream = await openEventStream(owner.client, { noCompare: true });
    streams.push(stream);
    const id = Number((await stream.next((b) => b.event === "connected")).id);
    expect((await post(owner.client, importBody("no-such-account", []))).json).toEqual(failed("Account not found."));
    expect((await post(owner.client, { account_id: owner.account_id })).json).toEqual(failed("transactions must be an array"));
    const share = shareLeg(owner.account_id, security_id);
    const share_id = share.transaction.investment_transaction_id as string;
    await seedInvestmentTransaction(stack, owner.user_id, owner.account_id, { investment_transaction_id: share_id });
    await softDeleteRow(stack, "investment_transactions", share_id);
    expect((await post(owner.client, importBody(owner.account_id, [share]))).json).toEqual(success({ written: 0, alreadyImported: 0, deleted: [share_id] }));
    const events = await threeEvents(stream);
    expect(events.map((e) => [e.event, e.data])).toEqual([
      ["accounts-updated", {}],
      ["investment_transactions-updated", {}],
      ["snapshots-updated", {}],
    ]);
    expect(events.map((e) => Number(e.id)).sort()).toEqual([id + 1, id + 2, id + 3]);
  });
});

// ---------------------------------------------------------------------------
// The monthly price backfill
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const yearMonth = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
const nextYearMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
};
const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
};

/** A calendar day `months` months back from today's, on day `day` of that month. */
const monthsBack = (months: number, day: number) => {
  const now = new Date();
  return localDay(new Date(now.getFullYear(), now.getMonth() - months, day));
};

/**
 * The months the backfill from a row dated `day` walks, as the day each is
 * priced for: the 15th, or yesterday for the current month. The row's date is
 * read as UTC midnight and its month taken in local time, so west of UTC it
 * can start a month earlier. Each priced day is read the same way: `asked` is
 * the day the price is asked for, `squashed` the day its snapshot is filed
 * under.
 */
const backfillMonths = (day: string) => {
  const now = yearMonth(new Date());
  const months: { month: string; asked: string; squashed: string; date: string }[] = [];
  for (let cursor = yearMonth(new Date(day)), touched = 0; cursor <= now && touched < 60; cursor = nextYearMonth(cursor), touched++) {
    const priced = cursor === now ? localDay(yesterday()) : `${cursor}-15`;
    const instant = new Date(priced);
    months.push({ month: cursor, asked: localDay(instant), squashed: squashedDay(instant), date: instant.toISOString() });
  }
  return months;
};

const aggsUrl = (symbol: string, day: string) => `GET /v2/aggs/ticker/${symbol}/range/1/day/${day}/${day}?apiKey=${POLYGON_KEY}`;
const yahooPriceUrl = (symbol: string, day: string) => {
  const target = Date.parse(`${day}T00:00:00Z`);
  return `GET /v8/finance/chart/${symbol}?interval=1d&period1=${Math.floor((target - DAY) / 1000)}&period2=${Math.floor((target + 2 * DAY) / 1000)}`;
};

/** Waits until a ticker has had `aggs` price requests at Polygon and `yahoo` chart requests at Yahoo, and checks no more came. */
const settle = async (symbol: string, { aggs = 0, yahoo = 0 }: { aggs?: number; yahoo?: number }) => {
  await stack.waitFor(
    () => stack.upstream.polygon.about(symbol, "aggs").length >= aggs && stack.upstream.yahoo.about(symbol).length >= yahoo,
    { what: `${aggs} price requests and ${yahoo} Yahoo requests for ${symbol}` },
  );
  expect(stack.upstream.polygon.about(symbol, "aggs")).toHaveLength(aggs);
  expect(stack.upstream.yahoo.about(symbol)).toHaveLength(yahoo);
};

describe("the monthly price backfill", () => {
  test("prices each security of the rows from its earliest row's month, in the order the rows first name them", async () => {
    const owner = await person("backfill");
    const [first, second, mapped, held] = [ticker("PFIRST"), ticker("PSECOND"), ticker("PMAPPED"), ticker("PHELD")];
    const [firstId, secondId] = [await fundSecurity(stack, first), await fundSecurity(stack, second)];
    const cash = await cashSecurity(stack);
    const a = owner.account_id;
    // The first security's earliest row is its second, which is already imported and counts all the same.
    const earliest = monthsBack(2, 20);
    const imported = shareLeg(a, firstId, { date: earliest });
    await seedInvestmentTransaction(stack, owner.user_id, a, { investment_transaction_id: imported.transaction.investment_transaction_id, security_id: firstId });
    const today = localDay(new Date());
    const legs = [
      shareLeg(a, firstId, { date: monthsBack(1, 20) }),
      shareLeg(a, secondId, { date: today }),
      imported,
      // Cash, and a row with no security, are not priced.
      shareLeg(a, cash, { date: monthsBack(3, 20) }),
      shareLeg(a, "", { date: monthsBack(3, 20) }),
    ];
    const months = backfillMonths(earliest);
    const secondMonths = backfillMonths(today);
    // Polygon refuses the first month, so Yahoo is not asked; it has no price for the second,
    // and Yahoo has; it prices the rest. Nobody prices the second security.
    stack.upstream.polygon.setTicker(first, { bars: months.slice(2).map((m, i) => ({ date: m.asked, close: 100 + i })) });
    stack.upstream.polygon.respond({ ticker: first, endpoint: "aggs", times: 1 }, polygonAnswer.error("Something went wrong"));
    stack.upstream.yahoo.setTicker(first, { bars: [{ date: months[1].asked, close: 55.5 }] });
    const body = importBody(a, legs, {
      // Securities only mapped or held are not priced.
      mappings: [{ investment: "Mapped", security_id: await fundSecurity(stack, mapped), restated: false }],
      holdings: [{ security_id: await fundSecurity(stack, held), date: "2026-03-02", quantity: 1, cost_basis: null, price: 1 }],
    });
    expect((await post(owner.client, body)).json).toEqual(success({ written: 4, alreadyImported: 1 }));

    await settle(first, { aggs: months.length, yahoo: 1 });
    expect(urlsOf(stack.upstream.polygon.about(first))).toEqual(months.map((m) => aggsUrl(first, m.asked)));
    expect(urlsOf(stack.upstream.yahoo.about(first))).toEqual([yahooPriceUrl(first, months[1].asked)]);
    await settle(second, { aggs: secondMonths.length, yahoo: secondMonths.length });
    expect(urlsOf(stack.upstream.polygon.about(second))).toEqual(secondMonths.map((m) => aggsUrl(second, m.asked)));
    expect(urlsOf(stack.upstream.yahoo.about(second))).toEqual(secondMonths.map((m) => yahooPriceUrl(second, m.asked)));
    // One security at a time: every request for the first comes before any for the second.
    const polygonOrder = stack.upstream.polygon
      .seen("/v2/aggs")
      .map((r) => r.path.split("/")[4])
      .filter((s) => s === first || s === second);
    expect(polygonOrder).toEqual([...months.map(() => first), ...secondMonths.map(() => second)]);

    const expected = [
      { snapshot_id: `${firstId}-${months[1].squashed}`, snapshot_date: months[1].date.slice(0, 19), close_price: 55.5 },
      ...months.slice(2).map((m, i) => ({ snapshot_id: `${firstId}-${m.squashed}`, snapshot_date: m.date.slice(0, 19), close_price: 100 + i })),
    ];
    await stack.waitFor(async () => (await storedSecuritySnapshots(stack, firstId)).length === expected.length, { what: "the backfilled prices" });
    expect(await storedSecuritySnapshots(stack, firstId)).toEqual(expected);
    expect(await storedSecuritySnapshots(stack, secondId)).toEqual([]);
    for (const symbol of [mapped, held]) expect(stack.upstream.polygon.about(symbol)).toEqual([]);
  });

  test("is not started by an import that stores nothing, nor by one with no rows", async () => {
    const owner = await person("nofill");
    const symbol = ticker("PSTOP");
    const security_id = await fundSecurity(stack, symbol);
    const share = shareLeg(owner.account_id, security_id, { date: monthsBack(1, 20) });
    const share_id = share.transaction.investment_transaction_id as string;
    await seedInvestmentTransaction(stack, owner.user_id, owner.account_id, { investment_transaction_id: share_id });
    await softDeleteRow(stack, "investment_transactions", share_id);
    expect((await post(owner.client, importBody(owner.account_id, [share]))).json).toEqual(success({ written: 0, alreadyImported: 0, deleted: [share_id] }));
    expect((await post(owner.client, importBody(owner.account_id, [shareLeg(owner.account_id, security_id, { name: 5 })]))).json.status).toBe("failed");
    const holding = { security_id, date: "2026-03-02", quantity: 1, cost_basis: null, price: 1 };
    expect((await post(owner.client, importBody(owner.account_id, [], { holdings: [holding] }))).json).toEqual(NOTHING_WRITTEN);
    // A later import that does price shows that nothing came before it.
    const today = localDay(new Date());
    expect((await post(owner.client, importBody(owner.account_id, [shareLeg(owner.account_id, security_id, { date: today })]))).json).toEqual(
      success({ written: 1, alreadyImported: 0 }),
    );
    const months = backfillMonths(today);
    await settle(symbol, { aggs: months.length, yahoo: months.length });
    expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual(months.map((m) => aggsUrl(symbol, m.asked)));
  });

  test("that fails is logged with the account, after the import has answered, and goes no further", async () => {
    const owner = await person("fillfail");
    const [broken, after] = [ticker("PBROKEN"), ticker("PAFTER")];
    const [brokenId, afterId] = [await fundSecurity(stack, broken), await fundSecurity(stack, after)];
    // Polygon has no price, and Yahoo answers with no chart at all.
    stack.upstream.yahoo.respond({ ticker: broken }, yahooAnswer.json(200, null));
    const today = localDay(new Date());
    const [month] = backfillMonths(today);
    const legs = [shareLeg(owner.account_id, brokenId, { date: today }), shareLeg(owner.account_id, afterId, { date: today })];
    const message = "backfillMonthlySecuritySnapshotsForward failed (plan statement)";
    const logged = stack.logCount(message);
    expect((await post(owner.client, importBody(owner.account_id, legs))).json).toEqual(success({ written: 2, alreadyImported: 0 }));
    await stack.waitForLog(message, { count: logged + 1 });
    expect(stack.logs.some((line) => line.includes(message) && line.includes(owner.account_id))).toBe(true);
    expect(urlsOf(stack.upstream.polygon.about(broken))).toEqual([aggsUrl(broken, month.asked)]);
    expect(urlsOf(stack.upstream.yahoo.about(broken))).toEqual([yahooPriceUrl(broken, month.asked)]);
    // The failure ends the whole backfill: the security after it is never priced.
    expect(stack.upstream.polygon.about(after)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Writes that fail
// ---------------------------------------------------------------------------

describe("a write that fails", () => {
  /** An account with a mapping, an entered position and a holding saved, and an import that changes all of them. */
  const scene = async (name: string) => {
    const owner = await person(name);
    const security_id = await cashSecurity(stack);
    await stack.db.query("UPDATE accounts SET plan_fund_mappings = $1 WHERE account_id = $2", [{ Saved: { security_id, restated: false } }, owner.account_id]);
    const entered = await seedHoldingSnapshot(stack, owner.user_id, owner.account_id, security_id);
    await seedHolding(stack, owner.user_id, owner.account_id, security_id);
    const share = shareLeg(owner.account_id, security_id);
    const body = importBody(owner.account_id, [share, cashLeg(share)], {
      mappings: [{ investment: "New", security_id, restated: true }],
      replace: [security_id],
      holdings: [{ security_id, date: "2026-03-02", quantity: 20, cost_basis: 1000, price: 50 }],
    });
    const state = async () => ({
      rows: await storedRows("investment_transactions", { account_id: owner.account_id }),
      mappings: await mappingsOf(owner.account_id),
      snapshot: (await rowOf(stack, "snapshots", entered))?.is_deleted,
      holding: withoutStamps(await rowOf(stack, "holdings", `${owner.account_id}-${security_id}`)),
    });
    return { owner, security_id, body, state, before: await state() };
  };

  const routeErrors = () => stack.logCount("Route handler error");

  // The cases run back to back: the route's alarm goes out for the first failure, and the
  // ones after it fall within its one-minute cooldown.
  test("rolls the whole import back and answers a server error, alarming once", async () => {
    const broken: [string, string, "UPDATE" | "INSERT"][] = [
      ["fail-rows", "investment_transactions", "INSERT"],
      ["fail-mappings", "accounts", "UPDATE"],
      ["fail-retire", "snapshots", "UPDATE"],
      ["fail-holding", "holdings", "INSERT"],
    ];
    for (const [name, table, event] of broken) {
      const { owner, body, state, before } = await scene(name);
      expect(before.mappings).toEqual({ Saved: expect.any(Object) });
      const errors = routeErrors();
      const result = await withWritesBroken(stack, table, { event, mode: "raise" }, () => post(owner.client, body));
      expect([name, result.status, result.json]).toEqual([name, 500, SERVER_ERROR]);
      await stack.waitFor(() => routeErrors() > errors, { what: "the route error log" });
      expect([name, await state()]).toEqual([name, before]);
      if (name === "fail-rows") {
        await stack.waitFor(() => alarmsFor(ROUTE).length > 0, { what: "the route error alarm" });
        expect(alarmsFor(ROUTE).map((alarm) => alarm.description)).toEqual(["**Error:** conformance: refused"]);
      }
    }

    // A figure or a holding too large for its column fails the same way.
    const holdingOf = (security_id: string, quantity: number, price: number) => ({ security_id, date: "2026-03-02", quantity, cost_basis: null, price });
    const tooLarge: [string, (body: ImportBody, security_id: string) => ImportBody][] = [
      ["fail-amount", (body, security_id) => ({ ...body, transactions: [shareLeg(body.account_id, security_id, { amount: 1e13 })] })],
      ["fail-value", (body, security_id) => ({ ...body, holdings: [holdingOf(security_id, 1e8, 1e8)] })],
      ["fail-quantity", (body, security_id) => ({ ...body, holdings: [holdingOf(security_id, 1e9, 0)] })],
    ];
    for (const [name, change] of tooLarge) {
      const { owner, security_id, body, state, before } = await scene(name);
      const errors = routeErrors();
      const result = await post(owner.client, change(body, security_id));
      expect([name, result.status, result.json]).toEqual([name, 500, SERVER_ERROR]);
      await stack.waitFor(() => routeErrors() > errors, { what: "the route error log" });
      expect([name, await state()]).toEqual([name, before]);
    }
    expect(alarmsFor(ROUTE)).toHaveLength(1);
  });

  test("but touches no row is not noticed: the mappings stay as they were and the rest is stored", async () => {
    const { owner, body, state, before } = await scene("skip-mappings");
    const result = await withWritesBroken(stack, "accounts", { event: "UPDATE", mode: "skip" }, () => post(owner.client, body));
    expect(result.json).toEqual(success({ written: 2, alreadyImported: 0 }));
    const after = await state();
    expect(after.mappings).toEqual(before.mappings);
    expect(after.rows).toHaveLength(2);
    expect(after.snapshot).toBe(true);
    expect(after.holding).toMatchObject({ quantity: 20, cost_basis: 1000, institution_price: 50, institution_value: 1000 });
  });
});
