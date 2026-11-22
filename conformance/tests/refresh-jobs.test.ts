/**
 * The two refresh jobs every server start runs, and the hourly sync after it:
 * stored CPI history from BLS, and a current price snapshot for every held
 * security and the benchmark. They have no route; a test sets the fakes up,
 * starts or restarts the server, and reads what the job stored and logged.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createUser, startStack, type Stack } from "../harness";
import { blsAnswer, type BlsObservation } from "../harness/upstreams/bls";
import { polygonAnswer } from "../harness/upstreams/polygon";

const SERIES = "CUUR0000SA0";

const stacks: Stack[] = [];
afterAll(async () => {
  await Promise.all(stacks.map((stack) => stack.stop()));
});

const start = async (options: Parameters<typeof startStack>[0] = {}): Promise<Stack> => {
  const stack = await startStack(options);
  stacks.push(stack);
  return stack;
};

/** The counts a job logged with `message`, from its latest log line. */
const loggedCounts = (stack: Stack, message: string): Record<string, unknown> => {
  const line = [...stack.logs].reverse().find((l) => l.includes(message));
  if (!line) throw new Error(`no "${message}" line in the log`);
  return JSON.parse(line.slice(line.indexOf("{")));
};

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD` of the local day `days` from today, as the servers compute it. */
const localDay = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const now = new Date();
const currentYear = now.getFullYear();
const firstYear = currentYear - 15 - 1;

/** Every month of `years` up to last month (the newest BLS can have published), plus annual averages. */
const monthsThroughLastMonth = (years: number[]): BlsObservation[] => {
  const newest = currentYear * 12 + now.getMonth() - 1;
  const observations: BlsObservation[] = [];
  for (const year of years) {
    for (let month = 1; month <= 12; month++) {
      if (year * 12 + month - 1 > newest) break;
      observations.push({ year, month, value: 200 + (year - 2000) * 6 + month / 4 });
    }
    observations.push({ year, month: 13, value: 999 });
  }
  return observations;
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const storedCpi = (stack: Stack) =>
  stack.db.query<{ cpi_snapshot_id: string; snapshot_date: string; index_value: string }>(
    "SELECT cpi_snapshot_id, to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date, index_value::text FROM cpi_snapshots ORDER BY snapshot_date",
  );

describe("the CPI refresh", () => {
  test("backfills an empty table in one run, ten years a keyless request, and skips annual averages and unpublished months", async () => {
    const stack = await start({
      beforeStart: (s) => {
        s.upstream.bls.setSeries(SERIES, [
          ...monthsThroughLastMonth(range(firstYear, currentYear)),
          { year: firstYear + 3, month: 6, value: "-" },
        ]);
      },
    });
    const requests = stack.upstream.bls.seen();
    expect(requests.map((r) => r.path)).toEqual(["/publicAPI/v1/timeseries/data/", "/publicAPI/v1/timeseries/data/"]);
    expect(requests.map((r) => r.json)).toEqual([
      { seriesid: [SERIES], startyear: String(firstYear), endyear: String(firstYear + 9) },
      { seriesid: [SERIES], startyear: String(firstYear + 10), endyear: String(currentYear) },
    ]);
    const rows = await storedCpi(stack);
    const expectedMonths = monthsThroughLastMonth(range(firstYear, currentYear)).filter((o) => o.month <= 12);
    expect(rows.map((r) => r.snapshot_date)).toEqual(expectedMonths.map((o) => `${o.year}-${pad(o.month)}-01`));
    expect(rows[0].cpi_snapshot_id).toBe(`${SERIES}-${firstYear}-01`);
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toEqual({
      requests: 2,
      upserted: expectedMonths.length,
      fresh: false,
      gated: false,
      deferred: 0,
      errors: 0,
    });

    // The next start finds the series current and asks BLS nothing.
    stack.upstream.hub.clearSeen();
    await stack.restart();
    expect(stack.upstream.bls.seen()).toEqual([]);
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toEqual({
      requests: 0,
      upserted: 0,
      fresh: true,
      gated: false,
      deferred: 0,
      errors: 0,
    });

    // GET /inflation now has a rate to answer.
    const inflation = await (await stack.login()).get<Record<string, unknown>>("/inflation");
    expect(inflation.json.status).toBe("success");
    expect(inflation.body).not.toBeNull();
  });

  test("with a registration key, asks the v2 endpoint for up to twenty years at once", async () => {
    const stack = await start({
      env: { BLS_API_KEY: "conformance-bls-key" },
      beforeStart: (s) => {
        s.upstream.bls.setRegistrationKeys(["conformance-bls-key"]);
        s.upstream.bls.setSeries(SERIES, monthsThroughLastMonth(range(firstYear, currentYear)));
      },
    });
    const requests = stack.upstream.bls.seen();
    expect(requests.map((r) => r.path)).toEqual(["/publicAPI/v2/timeseries/data/"]);
    expect(requests[0].json).toEqual({
      seriesid: [SERIES],
      startyear: String(firstYear),
      endyear: String(currentYear),
      registrationkey: "conformance-bls-key",
    });
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toMatchObject({ requests: 1, errors: 0, deferred: 0 });
  });

  test("refreshes a series that is behind only once the skip window has passed", async () => {
    const stack = await start({
      beforeStart: (s) => s.upstream.bls.setSeries(SERIES, monthsThroughLastMonth(range(firstYear, currentYear))),
    });
    // Drop the newest stored month: the series is now behind.
    await stack.db.query("DELETE FROM cpi_snapshots WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM cpi_snapshots)");

    stack.upstream.hub.clearSeen();
    await stack.restart();
    expect(stack.upstream.bls.seen()).toEqual([]);
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toMatchObject({ requests: 0, fresh: false, gated: true });

    await stack.db.query("UPDATE cpi_snapshots SET updated = now() - interval '23 hours'");
    const latestYear = Number(
      (await stack.db.one<{ y: string }>("SELECT to_char(MAX(snapshot_date), 'YYYY') AS y FROM cpi_snapshots"))!.y,
    );
    stack.upstream.hub.clearSeen();
    await stack.restart();
    expect(stack.upstream.bls.seen().map((r) => r.json)).toEqual([
      { seriesid: [SERIES], startyear: String(latestYear), endyear: String(currentYear) },
    ]);
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toMatchObject({ requests: 1, fresh: false, gated: false, errors: 0 });
  });

  test("skips past a span with no data, stops at an API error, and defers what is left", async () => {
    const stack = await start({
      beforeStart: (s) => {
        s.upstream.bls.respond({ times: 1 }, blsAnswer.status(503));
      },
    });
    // The first span failed with a server error: the run stopped and deferred the second.
    expect(stack.upstream.bls.seen()).toHaveLength(1);
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toEqual({
      requests: 1,
      upserted: 0,
      fresh: false,
      gated: false,
      deferred: 1,
      errors: 1,
    });
    // With no series at all, each span answers no data and the run carries on through all of them.
    stack.upstream.hub.clearSeen();
    await stack.restart();
    expect(stack.upstream.bls.seen()).toHaveLength(2);
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toEqual({
      requests: 2,
      upserted: 0,
      fresh: false,
      gated: false,
      deferred: 0,
      errors: 2,
    });
  });

  test("stops for the day when BLS says its daily threshold is reached", async () => {
    const stack = await start({
      beforeStart: (s) => {
        s.upstream.bls.setSeries(SERIES, monthsThroughLastMonth(range(firstYear, currentYear)));
        s.upstream.bls.setDailyLimit(1);
      },
    });
    expect(stack.upstream.bls.seen()).toHaveLength(2);
    expect(loggedCounts(stack, "Refreshed CPI snapshots")).toMatchObject({ requests: 2, deferred: 1, errors: 0 });
    expect(stack.logCount("refreshCpiSnapshots: daily BLS budget reached, deferring")).toBe(1);
  });
});

describe("the security price refresh", () => {
  /** Daily bars for the last `days` local days, newest last. */
  const recentBars = (days: number, base: number) =>
    range(1, days)
      .reverse()
      .map((ago, i) => ({ date: localDay(-ago + 1), close: base + i }));

  test("writes the benchmark's settled days since its static history, and its row when nobody holds it", async () => {
    const stack = await start({
      beforeStart: (s) => {
        s.upstream.polygon.setTicker("VOO", { detail: { name: "Vanguard S&P 500 ETF" }, bars: recentBars(60, 500) });
      },
    });
    const security = await stack.db.one("SELECT security_id, ticker_symbol, name, type FROM securities WHERE security_id = 'benchmark-VOO'");
    expect(security).toEqual({ security_id: "benchmark-VOO", ticker_symbol: "VOO", name: "Vanguard S&P 500 ETF", type: "etf" });
    const snapshots = await stack.db.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM snapshots WHERE security_id = 'benchmark-VOO' AND snapshot_type = 'security' ORDER BY snapshot_id",
    );
    expect(snapshots.length).toBeGreaterThan(0);
    for (const { snapshot_id } of snapshots) expect(snapshot_id).toMatch(/^benchmark-VOO-\d{8}$/);
    expect(loggedCounts(stack, "Refreshed active security snapshots")).toEqual({ refreshed: 1, fresh: 0, cash: 0, empty: 0, errors: 0 });

    // The next start is inside the skip window and asks nothing.
    stack.upstream.hub.clearSeen();
    await stack.restart();
    expect(stack.upstream.polygon.seen()).toEqual([]);
    expect(loggedCounts(stack, "Refreshed active security snapshots")).toEqual({ refreshed: 0, fresh: 1, cash: 0, empty: 0, errors: 0 });
  });

  test("prices every held security, skips cash and tickerless ones, falls back to Yahoo, and counts what failed", async () => {
    // The job runs at every start: start, seed what it should find, start again.
    const stack = await start();
    const s = stack;
    const owner = await createUser(s, `holder-${Date.now()}`);
    const securities = [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
      { security_id: "sec-fund", ticker_symbol: "VFIAX", type: "mutual fund" },
      { security_id: "sec-gone", ticker_symbol: "GONE", type: "equity" },
      { security_id: "sec-down", ticker_symbol: "DOWN", type: "equity" },
      { security_id: "sec-cash", ticker_symbol: "CASHX", type: "cash" },
      { security_id: "sec-cur", ticker_symbol: "CUR:USD", type: "equity" },
      { security_id: "sec-none", ticker_symbol: null, type: "equity" },
    ];
    for (const security of securities) {
      await s.db.insert("securities", security);
      await s.db.insert("holdings", {
        holding_id: `h-${security.security_id}`,
        user_id: owner.user_id,
        account_id: "acct-1",
        security_id: security.security_id,
        quantity: 1,
      });
    }
    // A deleted holding does not count.
    await s.db.insert("securities", { security_id: "sec-sold", ticker_symbol: "SOLD", type: "equity" });
    await s.db.insert("holdings", { holding_id: "h-sold", user_id: owner.user_id, account_id: "acct-1", security_id: "sec-sold", is_deleted: true });

    s.upstream.polygon.setTicker("AAPL", { bars: recentBars(5, 190) });
    s.upstream.polygon.setTicker("VOO", { bars: recentBars(60, 500) });
    s.upstream.polygon.respond({ ticker: "DOWN" }, polygonAnswer.status(503));
    s.upstream.yahoo.setTicker("VFIAX", { bars: recentBars(5, 450).map((bar) => ({ ...bar, adjclose: bar.close })) });
    s.upstream.hub.clearSeen();
    await s.restart();

    expect(loggedCounts(stack, "Refreshed active security snapshots")).toEqual({ refreshed: 3, fresh: 0, cash: 2, empty: 1, errors: 1 });
    const priced = await stack.db.query<{ security_id: string; close_price: string }>(
      `SELECT DISTINCT ON (security_id) security_id, close_price::text FROM snapshots
       WHERE snapshot_type = 'security' AND security_id IN ('sec-aapl', 'sec-fund', 'sec-gone', 'sec-down', 'sec-sold')
       ORDER BY security_id, snapshot_date DESC`,
    );
    expect(priced.map((row) => row.security_id).sort()).toEqual(["sec-aapl", "sec-fund"]);
    // A held equity is asked for only its latest close; nothing is asked for cash, tickerless or sold securities.
    for (const ticker of ["CASHX", "CUR:USD", "SOLD"]) expect(stack.upstream.polygon.about(ticker)).toEqual([]);
    // DOWN's server error was retried before it counted as an error.
    expect(stack.upstream.polygon.about("DOWN", "aggs").length).toBeGreaterThan(1);
  });
});
