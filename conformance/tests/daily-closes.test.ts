import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createUserClient,
  polygonAnswer,
  polygonBarTimestamp,
  startStack,
  urlsOf,
  yahooAnswer,
  yahooBarTimestamp,
  type ApiClient,
  type ApiResult,
  type PolygonAnswer,
  type PolygonEndpoint,
  type Stack,
} from "../harness";

const POLYGON_KEY = "conformance-polygon-key";
const DAY_MS = 86_400_000;

/** The servers' "today": the UTC day, which is where a fetched window ends. */
const today = (): string => new Date().toISOString().slice(0, 10);
const tomorrow = (): string => new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);

/** The requests one fetch of a ticker's window makes, as `urlsOf` renders them. */
const aggsUrl = (ticker: string, year: number): string =>
  `GET /v2/aggs/ticker/${ticker}/range/1/day/${year}-01-01/${today()}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
const dividendsUrl = (ticker: string, year: number): string =>
  `GET /v3/reference/dividends?ticker=${ticker}&ex_dividend_date.gte=${year}-01-01&ex_dividend_date.lte=${today()}&limit=1000&apiKey=${POLYGON_KEY}`;
const splitsUrl = (ticker: string, year: number): string =>
  `GET /v3/reference/splits?ticker=${ticker}&execution_date.gte=${year}-01-01&limit=1000&apiKey=${POLYGON_KEY}`;
const chartUrl = (ticker: string, year: number): string =>
  `GET /v8/finance/chart/${ticker}?interval=1d&period1=${Date.UTC(year, 0, 1) / 1000}&period2=${(Date.parse(today()) + DAY_MS) / 1000}`;

interface Bar {
  date: string;
  close: number;
  adjustedClose: number;
}
type Closes = { bars: Bar[] } | { message: string; retryable?: boolean };

const closes = (
  client: ApiClient,
  ticker: string,
  from: string,
  to: string,
  options: { noCompare?: boolean; headers?: Record<string, string> } = {},
): Promise<ApiResult<Closes>> => client.get<Closes>("/daily-closes", { query: { ticker, from, to }, ...options });

/** What the route answers when the lookup itself worked out, whatever it found. */
const answered = (body: Closes) => ({ status: "success", body });

/** A bar whose adjusted close is its close: nothing was paid out after it. */
const flat = (date: string, close: number): Bar => ({ date, close, adjustedClose: close });

let users = 0;
/**
 * A client signed in as a user of its own. Lookups that reach the market-data
 * gate draw on a budget of ten a minute per user, so tests do not share one.
 */
const newUser = async (stack: Stack): Promise<ApiClient> => (await createUserClient(stack, `closes-${++users}`)).client;

/**
 * Asks again, outside the comparison, until the background fetch has landed
 * and bars come back. While it runs the answer is "still loading", which
 * costs the user nothing.
 */
const untilLoaded = (stack: Stack, client: ApiClient, ticker: string, from: string, to: string, timeoutMs = 15_000) =>
  stack.waitFor(async () => "bars" in (await closes(client, ticker, from, to, { noCompare: true })).body, {
    timeoutMs,
    what: `the background fetch of ${ticker}`,
  });

describe("GET /daily-closes", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
    // The boot-time price refresh has called the fakes by now; only what the tests cause is kept.
    stack.upstream.hub.clearSeen();
  });
  afterAll(() => stack.stop());

  test("refuses an anonymous caller", async () => {
    const result = await closes(stack.anonymous(), "XANON", "2025-03-03", "2025-03-04");
    expect(result.status).toBe(401);
    expect(result.json).toEqual({ status: "failed", message: "Not authenticated." });
    expect(stack.upstream.polygon.about("XANON")).toEqual([]);
  });

  describe("validation", () => {
    const TICKER_MESSAGE = "Ticker symbol must be 1-16 characters of A-Z, 0-9, '.', '-' or ':'";
    const range = { from: "2025-03-03", to: "2025-03-04" };
    const cases: [string, Record<string, string | string[]>, string][] = [
      ["no parameters at all", {}, "Missing required parameter: ticker"],
      ["no ticker", range, "Missing required parameter: ticker"],
      ["a repeated ticker", { ticker: ["XVAL", "XVAL"], ...range }, "Parameter ticker must be a single value, not an array"],
      ["an empty ticker", { ticker: "", ...range }, "Parameter ticker cannot be empty"],
      ["a blank ticker", { ticker: " \t", ...range }, "Parameter ticker cannot be empty"],
      ["a ticker with a space inside", { ticker: "XV AL", ...range }, TICKER_MESSAGE],
      ["a ticker with a character outside the set", { ticker: "XVAL$", ...range }, TICKER_MESSAGE],
      ["a ticker with a slash", { ticker: "XV/AL", ...range }, TICKER_MESSAGE],
      ["a ticker with an underscore", { ticker: "XV_AL", ...range }, TICKER_MESSAGE],
      ["a ticker with a letter beyond A-Z", { ticker: "XVÅL", ...range }, TICKER_MESSAGE],
      ["a ticker of 17 characters", { ticker: "X".repeat(17), ...range }, TICKER_MESSAGE],
      ["a bad ticker before a missing range", { ticker: "XVAL$" }, TICKER_MESSAGE],
      ["no from", { ticker: "XVAL", to: range.to }, "Missing required parameter: from"],
      ["a repeated from", { ticker: "XVAL", from: [range.from, range.from], to: range.to }, "Parameter from must be a single value, not an array"],
      ["an empty from", { ticker: "XVAL", from: "", to: range.to }, "Parameter from cannot be empty"],
      ["a from that is not on the calendar", { ticker: "XVAL", from: "2025-02-30", to: range.to }, "from must be a YYYY-MM-DD date"],
      ["a from with a one-digit month", { ticker: "XVAL", from: "2025-3-03", to: range.to }, "from must be a YYYY-MM-DD date"],
      ["a from without dashes", { ticker: "XVAL", from: "20250303", to: range.to }, "from must be a YYYY-MM-DD date"],
      ["a from with a time", { ticker: "XVAL", from: "2025-03-03T00:00:00", to: range.to }, "from must be a YYYY-MM-DD date"],
      ["a from with a space around it", { ticker: "XVAL", from: " 2025-03-03", to: range.to }, "from must be a YYYY-MM-DD date"],
      ["a from that is a word", { ticker: "XVAL", from: "yesterday", to: range.to }, "from must be a YYYY-MM-DD date"],
      ["a bad from before a bad to", { ticker: "XVAL", from: "2025-13-01", to: "nope" }, "from must be a YYYY-MM-DD date"],
      ["a bad from before a missing to", { ticker: "XVAL", from: "2025-13-01" }, "from must be a YYYY-MM-DD date"],
      ["no to", { ticker: "XVAL", from: range.from }, "Missing required parameter: to"],
      ["a repeated to", { ticker: "XVAL", from: range.from, to: [range.to, range.to] }, "Parameter to must be a single value, not an array"],
      ["an empty to", { ticker: "XVAL", from: range.from, to: "" }, "Parameter to cannot be empty"],
      ["a to that is not on the calendar", { ticker: "XVAL", from: range.from, to: "2025-04-31" }, "to must be a YYYY-MM-DD date"],
      ["a to in another format", { ticker: "XVAL", from: range.from, to: "03/04/2025" }, "to must be a YYYY-MM-DD date"],
      ["a from after the to", { ticker: "XVAL", from: "2025-03-05", to: "2025-03-04" }, "from must not be after to"],
      ["a from a year after the to", { ticker: "XVAL", from: "2026-01-01", to: "2025-12-31" }, "from must not be after to"],
    ];
    for (const [name, query, message] of cases) {
      test(`refuses ${name}`, async () => {
        const client = await stack.login();
        const result = await client.get("/daily-closes", { query });
        expect(result.status).toBe(200);
        expect(result.json).toEqual({ status: "failed", message });
      });
    }

    test("reaches no upstream and spends none of the user's lookups on a refused request", async () => {
      // Every case above ran as admin: more than the ten lookups a minute a user gets.
      expect(cases.length).toBeGreaterThan(10);
      expect(stack.upstream.polygon.about("XVAL")).toEqual([]);
      expect(stack.upstream.yahoo.about("XVAL")).toEqual([]);
      const result = await closes(await stack.login(), "XVAL", "2025-03-03", "2025-03-03");
      expect(result.json).toEqual(answered({ message: "No Yahoo data found for XVAL" }));
    });
  });

  describe("from Polygon", () => {
    test("answers the bars as traded when nothing was paid out, from the year's start through today", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("XPUB", {
        bars: [
          { date: "2025-03-05", close: 101.25 },
          { date: "2025-03-03", close: 100 },
          { date: "2025-03-04", close: 99.5 },
          { date: "2025-03-06", close: 102 },
          { date: "2024-12-31", close: 90 },
        ],
      });
      const client = await newUser(stack);
      const result = await closes(client, "XPUB", "2025-03-03", "2025-03-05");
      expect(result.status).toBe(200);
      expect(result.json).toEqual(
        answered({ bars: [flat("2025-03-03", 100), flat("2025-03-04", 99.5), flat("2025-03-05", 101.25)] }),
      );
      // One range request for the window, then its dividends; with none declared, no splits are asked for.
      expect(urlsOf(polygon.about("XPUB"))).toEqual([aggsUrl("XPUB", 2025), dividendsUrl("XPUB", 2025)]);
      expect(stack.upstream.yahoo.about("XPUB")).toEqual([]);
    });

    test("serves later requests inside the fetched window from memory", async () => {
      const { polygon } = stack.upstream;
      const client = await newUser(stack);
      const before = polygon.about("XPUB").length;
      // The same range again, a sub-range, one that starts a day earlier, and the whole year so far.
      expect((await closes(client, "XPUB", "2025-03-03", "2025-03-05")).body).toEqual({
        bars: [flat("2025-03-03", 100), flat("2025-03-04", 99.5), flat("2025-03-05", 101.25)],
      });
      expect((await closes(client, "XPUB", "2025-03-04", "2025-03-04")).json).toEqual(
        answered({ bars: [flat("2025-03-04", 99.5)] }),
      );
      expect((await closes(client, "XPUB", "2025-03-02", "2025-03-03")).body).toEqual({ bars: [flat("2025-03-03", 100)] });
      expect((await closes(client, "XPUB", "2025-01-01", today())).body).toEqual({
        bars: [flat("2025-03-03", 100), flat("2025-03-04", 99.5), flat("2025-03-05", 101.25), flat("2025-03-06", 102)],
      });
      // Days of the window without a bar are an answer too, not a reason to ask again.
      expect((await closes(client, "XPUB", "2025-03-08", "2025-03-09")).json).toEqual(
        answered({ message: "No daily closes for XPUB between 2025-03-08 and 2025-03-09" }),
      );
      // Another user is served from the same memory.
      expect((await closes(await newUser(stack), "XPUB", "2025-03-06", "2025-03-06")).body).toEqual({
        bars: [flat("2025-03-06", 102)],
      });
      expect(polygon.about("XPUB")).toHaveLength(before);
    });

    test("fetches again for a range that starts before the window, back to that year's start", async () => {
      const { polygon } = stack.upstream;
      const client = await newUser(stack);
      const before = polygon.about("XPUB").length;
      const result = await closes(client, "XPUB", "2024-12-30", "2025-03-03");
      expect(result.body).toEqual({ bars: [flat("2024-12-31", 90), flat("2025-03-03", 100)] });
      expect(urlsOf(polygon.about("XPUB").slice(before))).toEqual([aggsUrl("XPUB", 2024), dividendsUrl("XPUB", 2024)]);
      // The wider window replaces the narrower one.
      expect((await closes(client, "XPUB", "2024-01-01", "2024-12-31")).body).toEqual({ bars: [flat("2024-12-31", 90)] });
      expect((await closes(client, "XPUB", "2025-03-06", "2025-03-06")).body).toEqual({ bars: [flat("2025-03-06", 102)] });
      expect(polygon.about("XPUB")).toHaveLength(before + 2);
    });

    test("fetches every time for a range that reaches past today, which no window covers", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("XFUTURE", { bars: [{ date: "2025-03-03", close: 10 }] });
      const client = await newUser(stack);
      for (let i = 0; i < 2; i++) {
        expect((await closes(client, "XFUTURE", "2025-03-03", tomorrow())).body).toEqual({ bars: [flat("2025-03-03", 10)] });
      }
      expect(urlsOf(polygon.about("XFUTURE"))).toEqual([
        aggsUrl("XFUTURE", 2025),
        dividendsUrl("XFUTURE", 2025),
        aggsUrl("XFUTURE", 2025),
        dividendsUrl("XFUTURE", 2025),
      ]);
      // Through today itself the window does cover.
      expect((await closes(client, "XFUTURE", "2025-03-03", today())).body).toEqual({ bars: [flat("2025-03-03", 10)] });
      expect(polygon.about("XFUTURE")).toHaveLength(4);
    });

    test("trims and upper-cases the ticker before looking it up", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("XLOWER", { bars: [{ date: "2025-03-03", close: 12.5 }] });
      const client = await newUser(stack);
      expect((await closes(client, "  xLower ", "2025-03-03", "2025-03-03")).json).toEqual(
        answered({ bars: [flat("2025-03-03", 12.5)] }),
      );
      expect(urlsOf(polygon.about("XLOWER"))).toEqual([aggsUrl("XLOWER", 2025), dividendsUrl("XLOWER", 2025)]);
      // The same symbol in another case is the same window.
      expect((await closes(client, "XLOWER", "2025-03-03", "2025-03-03")).body).toEqual({ bars: [flat("2025-03-03", 12.5)] });
      expect(polygon.about("XLOWER")).toHaveLength(2);
      // A letter whose upper case is two letters is looked up as those.
      polygon.setTicker("XSS", { bars: [{ date: "2025-03-03", close: 3 }] });
      expect((await closes(client, "xß", "2025-03-03", "2025-03-03")).body).toEqual({ bars: [flat("2025-03-03", 3)] });
      expect(urlsOf(polygon.about("XSS"))).toEqual([aggsUrl("XSS", 2025), dividendsUrl("XSS", 2025)]);
    });

    test("accepts a ticker of 16 characters, with dots, dashes and digits", async () => {
      const { polygon } = stack.upstream;
      const ticker = "BRK.B-2025.CLASS";
      expect(ticker).toHaveLength(16);
      polygon.setTicker(ticker, { bars: [{ date: "2025-03-03", close: 480 }] });
      expect((await closes(await newUser(stack), ticker, "2025-03-03", "2025-03-03")).body).toEqual({
        bars: [flat("2025-03-03", 480)],
      });
      expect(urlsOf(polygon.about(ticker))).toEqual([aggsUrl(ticker, 2025), dividendsUrl(ticker, 2025)]);
    });

    test("keeps a colon in the path and escapes it in a query", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("X:BTCUSD", {
        bars: [
          { date: "2025-03-03", close: 90000 },
          { date: "2025-03-04", close: 91000 },
        ],
        dividends: [{ exDate: "2025-03-04", cashAmount: 900 }],
      });
      const result = await closes(await newUser(stack), "x:btcusd", "2025-03-03", "2025-03-04");
      expect(result.body).toEqual({
        bars: [{ date: "2025-03-03", close: 90000, adjustedClose: 90000 * (1 - 900 / 90000) }, flat("2025-03-04", 91000)],
      });
      expect(urlsOf(polygon.about("X:BTCUSD"))).toEqual([
        aggsUrl("X:BTCUSD", 2025),
        dividendsUrl("X%3ABTCUSD", 2025),
        splitsUrl("X%3ABTCUSD", 2025),
      ]);
    });

    test("adjusts every close before an ex-date by the dividend over the prior close", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("XDIV", {
        bars: [
          { date: "2025-03-03", close: 100 },
          { date: "2025-03-04", close: 102 },
          { date: "2025-03-05", close: 99 },
          { date: "2025-06-02", close: 104 },
          { date: "2025-06-03", close: 103.2 },
        ],
        dividends: [
          { exDate: "2025-03-05", cashAmount: 2.04 },
          // An ex-date on a day without a bar applies at the next one.
          { exDate: "2025-05-31", cashAmount: 0.8125 },
          // One before the first bar and one after the last change no ratio in between.
          { exDate: "2025-03-03", cashAmount: 5 },
          { exDate: "2025-07-01", cashAmount: 5 },
        ],
      });
      const june = 1 - 0.8125 / 99;
      const march = june * (1 - 2.04 / 102);
      const client = await newUser(stack);
      const result = await closes(client, "XDIV", "2025-03-01", "2025-06-30");
      expect(result.json).toEqual(
        answered({
          bars: [
            { date: "2025-03-03", close: 100, adjustedClose: 100 * march },
            { date: "2025-03-04", close: 102, adjustedClose: 102 * march },
            { date: "2025-03-05", close: 99, adjustedClose: 99 * june },
            flat("2025-06-02", 104),
            flat("2025-06-03", 103.2),
          ],
        }),
      );
      // Dividends were declared, so the splits since the window's start are asked for as well.
      expect(urlsOf(polygon.about("XDIV"))).toEqual([aggsUrl("XDIV", 2025), dividendsUrl("XDIV", 2025), splitsUrl("XDIV", 2025)]);
      // The adjustment is the whole window's, whichever part of it is asked for.
      expect((await closes(client, "XDIV", "2025-03-04", "2025-03-04")).body).toEqual({
        bars: [{ date: "2025-03-04", close: 102, adjustedClose: 102 * march }],
      });
    });

    test("restates a dividend per today's share by every split after its ex-date", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("XSPLIT", {
        bars: [
          { date: "2025-03-03", close: 10 },
          { date: "2025-03-04", close: 9.9 },
          { date: "2025-09-01", close: 11 },
          { date: "2025-09-02", close: 10.75 },
        ],
        dividends: [
          { exDate: "2025-03-04", cashAmount: 1 },
          { exDate: "2025-09-02", cashAmount: 0.5 },
        ],
        splits: [
          // After the first ex-date only: that dividend was declared per ten of today's shares.
          { date: "2025-06-10", from: 1, to: 10 },
          // On the second ex-date itself: not after it.
          { date: "2025-09-02", from: 1, to: 2 },
          // Before the window: Polygon is not asked for it.
          { date: "2024-06-10", from: 1, to: 4 },
        ],
      });
      const september = 1 - 0.5 / 11;
      // The fake lists splits newest first: the dividend of 1 is halved, then divided by ten.
      const march = september * (1 - 1 / 2 / 10 / 10);
      const result = await closes(await newUser(stack), "XSPLIT", "2025-01-01", "2025-12-31");
      expect(result.body).toEqual({
        bars: [
          { date: "2025-03-03", close: 10, adjustedClose: 10 * march },
          { date: "2025-03-04", close: 9.9, adjustedClose: 9.9 * september },
          { date: "2025-09-01", close: 11, adjustedClose: 11 * september },
          flat("2025-09-02", 10.75),
        ],
      });
      expect(urlsOf(polygon.about("XSPLIT"))).toEqual([
        aggsUrl("XSPLIT", 2025),
        dividendsUrl("XSPLIT", 2025),
        splitsUrl("XSPLIT", 2025),
      ]);
    });

    test("keeps only the rows it can use and never follows a next page", async () => {
      const { polygon } = stack.upstream;
      const t = polygonBarTimestamp;
      polygon.respond(
        { ticker: "XODD", endpoint: "aggs" },
        polygonAnswer.json(200, {
          status: "OK",
          resultsCount: 7,
          results: [
            { c: 50, t: t("2025-03-03") },
            { c: 0, t: t("2025-03-04") },
            { c: -3, t: t("2025-03-05") },
            { c: "51", t: t("2025-03-06") },
            { t: t("2025-03-07") },
            { c: null, t: "not a time" },
            { c: 49, t: t("2025-03-10") },
            { c: 48.5, t: new Date(t("2025-03-11")).toISOString() },
          ],
          next_url: "https://api.polygon.io/v2/aggs/ticker/XODD/range/1/day/1/2?cursor=next",
        }),
      );
      polygon.respond(
        { ticker: "XODD", endpoint: "dividends" },
        polygonAnswer.json(200, {
          status: "OK",
          results: [
            { ex_dividend_date: "2025-03-10", cash_amount: "1" },
            { ex_dividend_date: 20250310, cash_amount: 1 },
            { cash_amount: 1 },
            { ex_dividend_date: "2025-03-10" },
            7,
            { ex_dividend_date: "2025-03-10", cash_amount: 2 },
            { ex_dividend_date: "2025-03-11", cash_amount: 0.97 },
          ],
          next_url: "https://api.polygon.io/v3/reference/dividends?cursor=next",
        }),
      );
      polygon.respond(
        { ticker: "XODD", endpoint: "splits" },
        polygonAnswer.json(200, {
          status: "OK",
          results: [
            { execution_date: "2025-03-11", split_from: 0, split_to: 4 },
            { execution_date: "2025-03-11", split_to: 4 },
            { execution_date: "2025-03-11", split_from: 1, split_to: null },
            { execution_date: "2025-03-11", split_from: -1, split_to: -4 },
            { split_from: 1, split_to: 4 },
            { execution_date: 20250311, split_from: 1, split_to: 4 },
            "2025-03-11",
            { execution_date: "2025-03-11", split_from: "1", split_to: "2" },
          ],
          next_url: "https://api.polygon.io/v3/reference/splits?cursor=next",
        }),
      );
      const last = 1 - 0.97 / 49;
      const first = last * (1 - 2 / 2 / 50);
      const result = await closes(await newUser(stack), "XODD", "2025-03-01", "2025-03-31");
      expect(result.json).toEqual(
        answered({
          bars: [
            { date: "2025-03-03", close: 50, adjustedClose: 50 * first },
            { date: "2025-03-10", close: 49, adjustedClose: 49 * last },
            flat("2025-03-11", 48.5),
          ],
        }),
      );
      expect(urlsOf(polygon.about("XODD"))).toEqual([aggsUrl("XODD", 2025), dividendsUrl("XODD", 2025), splitsUrl("XODD", 2025)]);
    });
  });

  describe("from Yahoo, when Polygon has no bars", () => {
    test("falls back for a symbol Polygon does not carry, with Yahoo's own adjusted closes", async () => {
      const { polygon, yahoo } = stack.upstream;
      yahoo.setTicker("XMUT", {
        longName: "Example Mutual Fund",
        bars: [
          { date: "2025-03-03", close: 50, adjustedClose: 40 },
          { date: "2025-03-04", close: null, adjustedClose: 41 },
          { date: "2025-03-05", close: 52, adjustedClose: 42.5 },
          { date: "2025-03-06", close: 53, adjustedClose: null },
          { date: "2025-03-07", close: 0, adjustedClose: 43 },
          { date: "2025-03-10", close: 54, adjustedClose: 0 },
          { date: "2025-03-11", close: 55 },
          { date: "2024-12-31", close: 45 },
        ],
      });
      const client = await newUser(stack);
      const result = await closes(client, "XMUT", "2025-03-03", "2025-03-11");
      expect(result.status).toBe(200);
      expect(result.json).toEqual(
        answered({
          bars: [
            { date: "2025-03-03", close: 50, adjustedClose: 40 },
            { date: "2025-03-05", close: 52, adjustedClose: 42.5 },
            flat("2025-03-11", 55),
          ],
        }),
      );
      // Polygon's 404 ends its part after one request; Yahoo is asked for the same window.
      expect(urlsOf(polygon.about("XMUT"))).toEqual([aggsUrl("XMUT", 2025)]);
      expect(urlsOf(yahoo.about("XMUT"))).toEqual([chartUrl("XMUT", 2025)]);
      const [request] = yahoo.about("XMUT");
      expect(request.headers["user-agent"]).toBe(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      );
      expect(request.headers.accept).toBe("application/json");

      // The window is cached like Polygon's.
      expect((await closes(client, "XMUT", "2025-03-05", "2025-03-10")).body).toEqual({
        bars: [{ date: "2025-03-05", close: 52, adjustedClose: 42.5 }],
      });
      expect(polygon.about("XMUT")).toHaveLength(1);
      expect(yahoo.about("XMUT")).toHaveLength(1);
    });

    test("falls back when Polygon knows the symbol but has no bar in the window", async () => {
      const { polygon, yahoo } = stack.upstream;
      polygon.setTicker("XQUIET", { bars: [{ date: "2023-06-01", close: 7 }], dividends: [{ exDate: "2025-03-04", cashAmount: 1 }] });
      yahoo.setTicker("XQUIET", { bars: [{ date: "2025-03-04", close: 8, adjustedClose: 7.5 }] });
      const result = await closes(await newUser(stack), "XQUIET", "2025-03-04", "2025-03-04");
      expect(result.body).toEqual({ bars: [{ date: "2025-03-04", close: 8, adjustedClose: 7.5 }] });
      expect(urlsOf(polygon.about("XQUIET"))).toEqual([aggsUrl("XQUIET", 2025)]);
      expect(urlsOf(yahoo.about("XQUIET"))).toEqual([chartUrl("XQUIET", 2025)]);
    });

    test("escapes the symbol in Yahoo's path", async () => {
      const { polygon, yahoo } = stack.upstream;
      yahoo.setTicker("X:ETHUSD", { bars: [{ date: "2025-03-04", close: 2000 }] });
      const result = await closes(await newUser(stack), "X:ETHUSD", "2025-03-04", "2025-03-04");
      expect(result.body).toEqual({ bars: [flat("2025-03-04", 2000)] });
      expect(urlsOf(polygon.about("X:ETHUSD"))).toEqual([aggsUrl("X:ETHUSD", 2025)]);
      expect(urlsOf(yahoo.about("X:ETHUSD"))).toEqual([chartUrl("X%3AETHUSD", 2025)]);
    });

    test("says so when neither source knows the symbol, and remembers it for a while", async () => {
      const { polygon, yahoo } = stack.upstream;
      const client = await newUser(stack);
      const result = await closes(client, "XNONE", "2025-03-03", "2025-03-04");
      expect(result.status).toBe(200);
      expect(result.json).toEqual(answered({ message: "No Yahoo data found for XNONE" }));
      expect(urlsOf(polygon.about("XNONE"))).toEqual([aggsUrl("XNONE", 2025)]);
      expect(urlsOf(yahoo.about("XNONE"))).toEqual([chartUrl("XNONE", 2025)]);

      // Asked again, for any range of that year, by anyone: the remembered answer, and no request.
      expect((await closes(client, "XNONE", "2025-03-03", "2025-03-04")).json).toEqual(
        answered({ message: "No Yahoo data found for XNONE" }),
      );
      expect((await closes(await newUser(stack), "XNONE", "2025-07-01", "2025-07-31")).body).toEqual({
        message: "No Yahoo data found for XNONE",
      });
      expect(polygon.about("XNONE")).toHaveLength(1);
      expect(yahoo.about("XNONE")).toHaveLength(1);

      // Another year is another window, with its own answer to find.
      expect((await closes(client, "XNONE", "2024-03-03", "2024-03-04")).body).toEqual({ message: "No Yahoo data found for XNONE" });
      expect(urlsOf(polygon.about("XNONE"))).toEqual([aggsUrl("XNONE", 2025), aggsUrl("XNONE", 2024)]);
      expect(urlsOf(yahoo.about("XNONE"))).toEqual([chartUrl("XNONE", 2025), chartUrl("XNONE", 2024)]);
    });

    test("treats a chart without usable bars as no data", async () => {
      const { yahoo } = stack.upstream;
      const client = await newUser(stack);
      const message = (ticker: string) => ({ message: `No daily closes for ${ticker} between 2025-01-01 and ${today()}` });

      // No adjusted series at all: the raw closes alone are not served.
      yahoo.setTicker("XRAW", { bars: [{ date: "2025-03-03", close: 50 }], withoutAdjusted: true });
      expect((await closes(client, "XRAW", "2025-03-03", "2025-03-03")).json).toEqual(answered(message("XRAW")));
      // A symbol Yahoo knows, with nothing in the window.
      yahoo.setTicker("XBARE", { bars: [{ date: "2023-03-03", close: 50 }] });
      expect((await closes(client, "XBARE", "2025-03-03", "2025-03-03")).json).toEqual(answered(message("XBARE")));
      // Bars, none of them with both closes.
      yahoo.setTicker("XHOLES", {
        bars: [
          { date: "2025-03-03", close: null, adjustedClose: 5 },
          { date: "2025-03-04", close: 5, adjustedClose: null },
        ],
      });
      expect((await closes(client, "XHOLES", "2025-03-03", "2025-03-04")).json).toEqual(answered(message("XHOLES")));
      // A chart whose result is empty or missing is Yahoo's "no such symbol".
      yahoo.respond({ ticker: "XEMPTY", times: 1 }, yahooAnswer.json(200, { chart: { result: [], error: null } }));
      expect((await closes(client, "XEMPTY", "2025-03-03", "2025-03-03")).body).toEqual({ message: "No Yahoo data found for XEMPTY" });
      yahoo.respond({ ticker: "XSHAPE", times: 1 }, yahooAnswer.json(200, { finance: { error: "moved" } }));
      expect((await closes(client, "XSHAPE", "2025-03-03", "2025-03-03")).body).toEqual({ message: "No Yahoo data found for XSHAPE" });

      for (const ticker of ["XRAW", "XBARE", "XHOLES", "XEMPTY", "XSHAPE"]) {
        expect(urlsOf(yahoo.about(ticker))).toEqual([chartUrl(ticker, 2025)]);
      }
      // Each is remembered: a later bar on Yahoo's side is not seen within the memo's life.
      yahoo.setTicker("XBARE", { bars: [{ date: "2025-03-03", close: 50 }] });
      expect((await closes(client, "XBARE", "2025-03-03", "2025-03-03")).body).toEqual(message("XBARE"));
      expect(yahoo.about("XBARE")).toHaveLength(1);
    });

    test("answers \"still loading\" when Yahoo throttles, and fetches again in the background", async () => {
      const { polygon, yahoo } = stack.upstream;
      yahoo.setTicker("XBUSY", { bars: [{ date: "2025-03-03", close: 20, adjustedClose: 19 }] });
      yahoo.respond({ ticker: "XBUSY", times: 1 }, yahooAnswer.rateLimited());
      const client = await newUser(stack);
      const result = await closes(client, "XBUSY", "2025-03-03", "2025-03-03");
      expect(result.status).toBe(200);
      expect(result.json).toEqual(
        answered({ message: "Prices for XBUSY are still loading. Retry in a minute.", retryable: true }),
      );
      // A throttled lookup is not remembered as a failure: the background fetch asks both again.
      await untilLoaded(stack, client, "XBUSY", "2025-03-03", "2025-03-03");
      expect((await closes(client, "XBUSY", "2025-03-03", "2025-03-03")).json).toEqual(
        answered({ bars: [{ date: "2025-03-03", close: 20, adjustedClose: 19 }] }),
      );
      expect(urlsOf(polygon.about("XBUSY"))).toEqual([aggsUrl("XBUSY", 2025), aggsUrl("XBUSY", 2025)]);
      expect(urlsOf(yahoo.about("XBUSY"))).toEqual([chartUrl("XBUSY", 2025), chartUrl("XBUSY", 2025)]);
    });

    test("reports an answer from Yahoo that is not JSON, and remembers it", async () => {
      const { polygon, yahoo } = stack.upstream;
      yahoo.respond({ ticker: "XHTML" }, yahooAnswer.status(500));
      const client = await newUser(stack);
      const expected = answered({ message: "Bad response for XHTML: JSON Parse error: Unrecognized token '<'" });
      expect((await closes(client, "XHTML", "2025-03-03", "2025-03-03")).json).toEqual(expected);
      expect((await closes(client, "XHTML", "2025-03-03", "2025-03-03")).json).toEqual(expected);
      expect(urlsOf(polygon.about("XHTML"))).toEqual([aggsUrl("XHTML", 2025)]);
      expect(urlsOf(yahoo.about("XHTML"))).toEqual([chartUrl("XHTML", 2025)]);

      // Each kind of malformed body reads as the engine reports it.
      const bodies: [string, string, string][] = [
        ["XTEXT", "Service Unavailable", 'Unexpected identifier "Service"'],
        ["XCUT", '{"chart":{"result":[{"meta":{', "Expected '}'"],
        ["XBLANK", " ", "Unexpected EOF"],
        ["XTRAIL", '{"chart":{}} trailing', "Unable to parse JSON string"],
      ];
      for (const [ticker, body, reason] of bodies) {
        yahoo.respond({ ticker }, yahooAnswer.status(200, body, "application/json"));
        expect((await closes(client, ticker, "2025-03-03", "2025-03-03")).body).toEqual({
          message: `Bad response for ${ticker}: JSON Parse error: ${reason}`,
        });
      }
    });

    test("fails as a server error on an empty answer from Yahoo, and does not remember it", async () => {
      const { polygon, yahoo, discord } = stack.upstream;
      const restore = yahoo.respond({ ticker: "XVOID" }, yahooAnswer.status(502, ""));
      const client = await newUser(stack);
      for (let i = 0; i < 2; i++) {
        const result = await closes(client, "XVOID", "2025-03-03", "2025-03-03");
        expect(result.status).toBe(500);
        expect(result.json).toEqual({ status: "error", message: "Internal server error" });
      }
      expect(urlsOf(polygon.about("XVOID"))).toEqual([aggsUrl("XVOID", 2025), aggsUrl("XVOID", 2025)]);
      expect(urlsOf(yahoo.about("XVOID"))).toEqual([chartUrl("XVOID", 2025), chartUrl("XVOID", 2025)]);

      await stack.waitFor(() => discord.alarms().length >= 1, { what: "the route error alarm" });
      const [alarm] = discord.alarms();
      expect(alarm.title).toBe("🚨 Budget Server Error: Route Error: GET /daily-closes");
      expect(alarm.description).toBe("**Error:** null is not an object (evaluating 'json.chart')");

      // Once Yahoo answers properly the lookup works: nothing of the failure was kept.
      restore();
      yahoo.setTicker("XVOID", { bars: [{ date: "2025-03-03", close: 6 }] });
      expect((await closes(client, "XVOID", "2025-03-03", "2025-03-03")).body).toEqual({ bars: [flat("2025-03-03", 6)] });

      // A chart whose timestamps are not a list fails the same way. (This route's
      // alarm went out a moment ago; its cooldown keeps this one from sending another.)
      for (const [ticker, timestamp] of [["XNOLIST", 5], ["XNOLISTB", "1741000000"], ["XNOLISTC", { 0: 1741000000 }]] as const) {
        yahoo.respond({ ticker }, yahooAnswer.json(200, { chart: { result: [{ timestamp, indicators: {} }], error: null } }));
        const result = await closes(client, ticker, "2025-03-03", "2025-03-03");
        expect(result.status).toBe(500);
        expect(result.json).toEqual({ status: "error", message: "Internal server error" });
        expect(urlsOf(yahoo.about(ticker))).toEqual([chartUrl(ticker, 2025)]);
      }
    });

    test("reads a chart of an unusual shape as far as it goes", async () => {
      const { yahoo } = stack.upstream;
      const at = yahooBarTimestamp("2025-03-03");
      const bar = { bars: [{ date: "2025-03-03", close: 5, adjustedClose: 4 }] };
      const noBars = (ticker: string) => ({ message: `No daily closes for ${ticker} between 2025-01-01 and ${today()}` });
      const unknown = (ticker: string) => ({ message: `No Yahoo data found for ${ticker}` });
      const series = { quote: [{ close: [5, 6, 7] }], adjclose: [{ adjclose: [4, 5, 6] }] };
      const shapes: [string, unknown, (ticker: string) => Closes][] = [
        // Numbered keys stand in for a list, for the result and for each series.
        ["XCHART1", { chart: { result: { 0: { timestamp: [at], indicators: series } } } }, () => bar],
        [
          "XCHART2",
          { chart: { result: [{ timestamp: [at], indicators: { quote: { 0: { close: [5] } }, adjclose: { 0: { adjclose: [4] } } } }] } },
          () => bar,
        ],
        // A timestamp written as text counts; `null` and `true` are moments of 1970, outside any window asked for.
        ["XCHART3", { chart: { result: [{ timestamp: [String(at), null, true], indicators: series }] } }, () => bar],
        // Closes that are not numbers are not closes.
        [
          "XCHART4",
          { chart: { result: [{ timestamp: [at], indicators: { quote: [{ close: "5" }], adjclose: [{ adjclose: [4] }] } }] } },
          noBars,
        ],
        ["XCHART5", { chart: { result: [{ timestamp: [at], indicators: 5 }] } }, noBars],
        // Anything truthy in the result's first place is taken for a chart, however empty.
        ["XCHART6", { chart: { result: "abc" } }, noBars],
        ["XCHART7", { chart: { result: [5] } }, noBars],
        // Nothing there, or nothing truthy, is Yahoo not knowing the symbol.
        ["XCHART8", { chart: { result: [0] } }, unknown],
        ["XCHART9", { chart: 5 }, unknown],
        ["XCHART10", [], unknown],
      ];
      const client = await newUser(stack);
      for (const [ticker, body, expected] of shapes) {
        yahoo.respond({ ticker }, yahooAnswer.json(200, body));
        const result = await closes(client, ticker, "2025-03-03", "2025-03-03");
        expect(result.status).toBe(200);
        expect(result.json).toEqual(answered(expected(ticker)));
        expect(urlsOf(yahoo.about(ticker))).toEqual([chartUrl(ticker, 2025)]);
      }
    });
  });

  describe("when Polygon refuses", () => {
    test("passes on a plan limit and remembers it, without asking Yahoo", async () => {
      const { polygon, yahoo } = stack.upstream;
      yahoo.setTicker("XPLAN", { bars: [{ date: "2025-03-03", close: 1 }] });
      polygon.respond({ ticker: "XPLAN" }, polygonAnswer.planLimit());
      const client = await newUser(stack);
      const expected = answered({
        message: "Your plan doesn't include this data timeframe. Please upgrade your plan at https://polygon.io/pricing",
      });
      const result = await closes(client, "XPLAN", "2025-03-03", "2025-03-03");
      expect(result.status).toBe(200);
      expect(result.json).toEqual(expected);
      expect((await closes(client, "XPLAN", "2025-06-03", "2025-06-03")).json).toEqual(expected);
      expect(urlsOf(polygon.about("XPLAN"))).toEqual([aggsUrl("XPLAN", 2025)]);
      expect(yahoo.about("XPLAN")).toEqual([]);

      // Without a message of Polygon's own, one names what was asked for.
      polygon.respond({ ticker: "XPLAN2" }, polygonAnswer.planLimit(null));
      expect((await closes(client, "XPLAN2", "2025-03-03", "2025-03-03")).body).toEqual({
        message: `Polygon plan does not include data for XPLAN2 in [2025-01-01, ${today()}]`,
      });
      // The same envelope on a 200 is the same refusal.
      polygon.respond({ ticker: "XPLAN3" }, polygonAnswer.json(200, { status: "NOT_AUTHORIZED", message: 42 }));
      expect((await closes(client, "XPLAN3", "2025-03-03", "2025-03-03")).body).toEqual({
        message: `Polygon plan does not include data for XPLAN3 in [2025-01-01, ${today()}]`,
      });
    });

    test("passes on an error envelope, whatever the HTTP status", async () => {
      const { polygon, yahoo } = stack.upstream;
      const client = await newUser(stack);
      polygon.respond({ ticker: "XERR" }, polygonAnswer.error("invalid date range requested"));
      const expected = answered({ message: "invalid date range requested" });
      expect((await closes(client, "XERR", "2025-03-03", "2025-03-03")).json).toEqual(expected);
      expect((await closes(client, "XERR", "2025-03-03", "2025-03-03")).json).toEqual(expected);
      expect(urlsOf(polygon.about("XERR"))).toEqual([aggsUrl("XERR", 2025)]);
      expect(yahoo.about("XERR")).toEqual([]);

      polygon.respond({ ticker: "XERR2" }, polygonAnswer.error(null));
      expect((await closes(client, "XERR2", "2025-03-03", "2025-03-03")).body).toEqual({
        message: `Polygon refused the lookup for XERR2 in [2025-01-01, ${today()}] (HTTP 200)`,
      });
      // A 404 that carries the error envelope is a refusal, not "no such symbol".
      polygon.respond({ ticker: "XERR3" }, polygonAnswer.error("ticker is malformed", 404));
      expect((await closes(client, "XERR3", "2025-03-03", "2025-03-03")).body).toEqual({ message: "ticker is malformed" });
      // Any other client error is one too, with or without an envelope.
      polygon.respond({ ticker: "XERR4" }, polygonAnswer.json(401, { status: "ERROR", error: "Unknown API Key" }));
      expect((await closes(client, "XERR4", "2025-03-03", "2025-03-03")).body).toEqual({ message: "Unknown API Key" });
      polygon.respond({ ticker: "XERR5" }, polygonAnswer.json(400, { detail: "bad" }));
      expect((await closes(client, "XERR5", "2025-03-03", "2025-03-03")).body).toEqual({
        message: `Polygon refused the lookup for XERR5 in [2025-01-01, ${today()}] (HTTP 400)`,
      });
      for (const ticker of ["XERR2", "XERR3", "XERR4", "XERR5"]) {
        expect(urlsOf(polygon.about(ticker))).toEqual([aggsUrl(ticker, 2025)]);
        expect(yahoo.about(ticker)).toEqual([]);
      }
    });

    test("passes on Polygon's own rate limit as a failure, once, without retrying", async () => {
      const { polygon, yahoo } = stack.upstream;
      polygon.setTicker("XRATE", { bars: [{ date: "2025-03-03", close: 1 }] });
      polygon.respond({ ticker: "XRATE", times: 1 }, polygonAnswer.rateLimited());
      const client = await newUser(stack);
      const expected = answered({
        message:
          "You've exceeded the maximum requests per minute, please wait or upgrade your subscription to continue. https://polygon.io/pricing",
      });
      expect((await closes(client, "XRATE", "2025-03-03", "2025-03-03")).json).toEqual(expected);
      // Polygon would answer now, but the failure is remembered for the window.
      expect((await closes(client, "XRATE", "2025-03-03", "2025-03-03")).json).toEqual(expected);
      expect(urlsOf(polygon.about("XRATE"))).toEqual([aggsUrl("XRATE", 2025)]);
      expect(yahoo.about("XRATE")).toEqual([]);
    });

    test("fails the whole fetch when the dividends or the splits are refused", async () => {
      const { polygon, yahoo } = stack.upstream;
      const client = await newUser(stack);
      const data = {
        bars: [
          { date: "2025-03-03", close: 10 },
          { date: "2025-03-04", close: 9.9 },
        ],
        dividends: [{ exDate: "2025-03-04", cashAmount: 1 }],
      };
      polygon.setTicker("XNODIV", data);
      polygon.respond({ ticker: "XNODIV", endpoint: "dividends" }, polygonAnswer.planLimit(null));
      expect((await closes(client, "XNODIV", "2025-03-03", "2025-03-04")).json).toEqual(
        answered({ message: "Polygon plan does not include data for XNODIV dividends" }),
      );
      expect(urlsOf(polygon.about("XNODIV"))).toEqual([aggsUrl("XNODIV", 2025), dividendsUrl("XNODIV", 2025)]);

      polygon.setTicker("XNOSPLIT", data);
      polygon.respond({ ticker: "XNOSPLIT", endpoint: "splits" }, polygonAnswer.json(429, {}));
      expect((await closes(client, "XNOSPLIT", "2025-03-03", "2025-03-04")).json).toEqual(
        answered({ message: "Polygon refused the lookup for XNOSPLIT splits (HTTP 429)" }),
      );
      expect(urlsOf(polygon.about("XNOSPLIT"))).toEqual([
        aggsUrl("XNOSPLIT", 2025),
        dividendsUrl("XNOSPLIT", 2025),
        splitsUrl("XNOSPLIT", 2025),
      ]);
      // Neither is answered from the bars alone, nor retried, nor handed to Yahoo.
      expect((await closes(client, "XNOSPLIT", "2025-03-03", "2025-03-04")).body).toEqual({
        message: "Polygon refused the lookup for XNOSPLIT splits (HTTP 429)",
      });
      expect(polygon.about("XNOSPLIT")).toHaveLength(3);
      expect(yahoo.about("XNODIV")).toEqual([]);
      expect(yahoo.about("XNOSPLIT")).toEqual([]);
    });

    test("tries a failing server three times, a second apart and then two, before giving up", async () => {
      const { polygon, yahoo } = stack.upstream;
      polygon.setTicker("XDOWN", { bars: [{ date: "2025-03-03", close: 1 }] });
      polygon.respond({ ticker: "XDOWN", endpoint: "aggs" }, polygonAnswer.error("upstream is unhappy", 503));
      const client = await newUser(stack);
      const started = Date.now();
      const result = await closes(client, "XDOWN", "2025-03-03", "2025-03-03");
      const elapsed = Date.now() - started;
      expect(result.status).toBe(200);
      expect(result.json).toEqual(answered({ message: "upstream is unhappy" }));
      const calls = polygon.about("XDOWN");
      expect(urlsOf(calls)).toEqual([aggsUrl("XDOWN", 2025), aggsUrl("XDOWN", 2025), aggsUrl("XDOWN", 2025)]);
      // The waits are 1 s and then 2 s; the bounds leave the timers some slack.
      expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(950);
      expect(calls[1].at - calls[0].at).toBeLessThan(1950);
      expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(1950);
      expect(elapsed).toBeGreaterThanOrEqual(2950);
      expect(yahoo.about("XDOWN")).toEqual([]);
      // The failure is remembered: no fourth request.
      expect((await closes(client, "XDOWN", "2025-03-03", "2025-03-03")).body).toEqual({ message: "upstream is unhappy" });
      expect(polygon.about("XDOWN")).toHaveLength(3);
    }, 20_000);

    test("carries on when a retry succeeds", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("XFLAKY", {
        bars: [
          { date: "2025-03-03", close: 10 },
          { date: "2025-03-04", close: 9.9 },
        ],
        dividends: [{ exDate: "2025-03-04", cashAmount: 1 }],
      });
      // The range request fails twice with a gateway's page, the dividends once.
      polygon.respond({ ticker: "XFLAKY", endpoint: "aggs", times: 2 }, polygonAnswer.status(502));
      polygon.respond({ ticker: "XFLAKY", endpoint: "dividends", times: 1 }, polygonAnswer.status(500, ""));
      const result = await closes(await newUser(stack), "XFLAKY", "2025-03-03", "2025-03-04");
      expect(result.json).toEqual(
        answered({ bars: [{ date: "2025-03-03", close: 10, adjustedClose: 10 * (1 - 1 / 10) }, flat("2025-03-04", 9.9)] }),
      );
      expect(urlsOf(polygon.about("XFLAKY"))).toEqual([
        aggsUrl("XFLAKY", 2025),
        aggsUrl("XFLAKY", 2025),
        aggsUrl("XFLAKY", 2025),
        dividendsUrl("XFLAKY", 2025),
        dividendsUrl("XFLAKY", 2025),
        splitsUrl("XFLAKY", 2025),
      ]);
    }, 20_000);

    test("finishes a fetch whose caller hung up, and keeps what it found", async () => {
      const { polygon } = stack.upstream;
      polygon.setTicker("XHANGUP", { bars: [{ date: "2025-03-03", close: 10 }] });
      polygon.respond({ ticker: "XHANGUP", endpoint: "aggs", times: 2 }, polygonAnswer.status(502));
      const client = await newUser(stack);
      const impatient = new AbortController();
      const abandoned = client
        .get("/daily-closes", { query: { ticker: "XHANGUP", from: "2025-03-03", to: "2025-03-03" }, signal: impatient.signal })
        .then(
          () => "answered",
          () => "abandoned",
        );
      // The caller leaves while the server waits to retry the first failure.
      await stack.waitFor(() => polygon.about("XHANGUP").length === 1, { what: "the first request to Polygon" });
      impatient.abort();
      expect(await abandoned).toBe("abandoned");

      // The retries and the rest of the fetch go on without them.
      await stack.waitFor(() => polygon.about("XHANGUP").length === 4, { what: "the fetch to finish on its own" });
      expect(urlsOf(polygon.about("XHANGUP"))).toEqual([
        aggsUrl("XHANGUP", 2025),
        aggsUrl("XHANGUP", 2025),
        aggsUrl("XHANGUP", 2025),
        dividendsUrl("XHANGUP", 2025),
      ]);
      // Nothing outside the server shows the moment the last answer is stored:
      // give it a quarter of a second, a thousand times what it takes.
      const last = polygon.about("XHANGUP")[3];
      await stack.waitFor(() => Date.now() - last.at >= 250, { what: "the last answer to be stored" });
      expect((await closes(client, "XHANGUP", "2025-03-03", "2025-03-03")).json).toEqual(
        answered({ bars: [flat("2025-03-03", 10)] }),
      );
      expect(polygon.about("XHANGUP")).toHaveLength(4);
    }, 20_000);

    test("reports an answer that cannot be read", async () => {
      const { polygon, yahoo } = stack.upstream;
      const t = polygonBarTimestamp;
      // What the reference's JavaScript engine says when `results` is there but is not a list.
      const notAList = {
        aggs: "(aggs.json.results ?? []).filter is not a function. (In '(aggs.json.results ?? []).filter((r) => Number.isFinite(r.c) && r.c > 0)', '(aggs.json.results ?? []).filter' is undefined)",
        dividends:
          "(divs.json.results ?? []).filter is not a function. (In '(divs.json.results ?? []).filter((d) => typeof d.ex_dividend_date === \"string\" && typeof d.cash_amount === \"number\")', '(divs.json.results ?? []).filter' is undefined)",
        splits:
          "(splitsResponse.json.results ?? []).filter is not a function. (In '(splitsResponse.json.results ?? []).filter((s) => typeof s.execution_date === \"string\" && (s.split_from ?? 0) > 0 && (s.split_to ?? 0) > 0)', '(splitsResponse.json.results ?? []).filter' is undefined)",
      };
      const noStatus = "null is not an object (evaluating 'json.status')";
      const unreadable: [string, Exclude<PolygonEndpoint, "detail">, PolygonAnswer, string][] = [
        // A page instead of JSON, on a status that is not retried.
        ["XPAGE", "aggs", polygonAnswer.status(403), "JSON Parse error: Unrecognized token '<'"],
        ["XWORDS", "aggs", polygonAnswer.status(200, "Bad Gateway", "text/plain"), 'JSON Parse error: Unexpected identifier "Bad"'],
        ["XHALF", "aggs", polygonAnswer.status(200, '{"status":"OK","results":[{"c":1', "application/json"), "JSON Parse error: Expected '}'"],
        // No body at all reads as `null`, which has no status to look at.
        ["XNOBODY", "aggs", polygonAnswer.status(200, ""), noStatus],
        ["XNULL", "aggs", polygonAnswer.json(200, null), noStatus],
        // A bar that passes the filter but carries no time.
        ["XNOTIME", "aggs", polygonAnswer.json(200, { results: [{ c: 5, t: t("2025-03-03") }, { c: 6 }] }), "Invalid Date"],
        ["XBADTIME", "aggs", polygonAnswer.json(200, { results: [{ c: 5, t: "soon" }] }), "Invalid Date"],
        // Rows that are `null`, and results that are not rows at all.
        ["XNULLBAR", "aggs", polygonAnswer.json(200, { results: [null] }), "null is not an object (evaluating 'r.c')"],
        ["XNULLDIV", "dividends", polygonAnswer.json(200, { results: [null] }), "null is not an object (evaluating 'd.ex_dividend_date')"],
        ["XNULLSPLIT", "splits", polygonAnswer.json(200, { results: [null] }), "null is not an object (evaluating 's.execution_date')"],
        ["XNOLIST1", "aggs", polygonAnswer.json(200, { results: {} }), notAList.aggs],
        ["XNOLIST2", "aggs", polygonAnswer.json(200, { results: 0 }), notAList.aggs],
        ["XNOLIST3", "dividends", polygonAnswer.json(200, { results: "none" }), notAList.dividends],
        ["XNOLIST4", "splits", polygonAnswer.json(200, { results: true }), notAList.splits],
        // The later requests of a fetch are read the same way as the first.
        ["XDIVPAGE", "dividends", polygonAnswer.status(403), "JSON Parse error: Unrecognized token '<'"],
        ["XSPLITNULL", "splits", polygonAnswer.status(200, ""), noStatus],
      ];
      const requests = { aggs: 1, dividends: 2, splits: 3 };
      let client = await newUser(stack);
      for (const [index, [ticker, endpoint, answer, reason]] of unreadable.entries()) {
        // Ten lookups a minute each: a second user takes over.
        if (index === 9) client = await newUser(stack);
        polygon.setTicker(ticker, {
          bars: [
            { date: "2025-03-03", close: 10 },
            { date: "2025-03-04", close: 9.9 },
          ],
          dividends: [{ exDate: "2025-03-04", cashAmount: 1 }],
        });
        polygon.respond({ ticker, endpoint }, answer);
        const result = await closes(client, ticker, "2025-03-03", "2025-03-04");
        expect(result.status).toBe(200);
        expect(result.json).toEqual(answered({ message: `Failed to fetch closes for ${ticker}: ${reason}` }));
        expect(urlsOf(polygon.about(ticker))).toEqual(
          [aggsUrl(ticker, 2025), dividendsUrl(ticker, 2025), splitsUrl(ticker, 2025)].slice(0, requests[endpoint]),
        );
        expect(yahoo.about(ticker)).toEqual([]);
      }
      // Remembered like any other failure.
      expect((await closes(client, "XPAGE", "2025-03-03", "2025-03-03")).body).toEqual({
        message: "Failed to fetch closes for XPAGE: JSON Parse error: Unrecognized token '<'",
      });
      expect(polygon.about("XPAGE")).toHaveLength(1);
    });

    test("reads an answer of another shape as no bars, and asks Yahoo", async () => {
      const { polygon, yahoo } = stack.upstream;
      const client = await newUser(stack);
      const shapes: [string, unknown][] = [
        ["XSHAPE1", { status: "OK", results: [] }],
        ["XSHAPE2", { status: "OK", results: null }],
        ["XSHAPE3", [{ c: 5, t: 1 }]],
        ["XSHAPE4", "results"],
        ["XSHAPE5", 5],
        ["XSHAPE6", { results: [{ c: 0, t: polygonBarTimestamp("2025-03-03") }, "5", 5, [5], {}] }],
      ];
      for (const [ticker, body] of shapes) {
        polygon.respond({ ticker, endpoint: "aggs" }, polygonAnswer.json(200, body));
        expect((await closes(client, ticker, "2025-03-03", "2025-03-03")).body).toEqual({
          message: `No Yahoo data found for ${ticker}`,
        });
        expect(urlsOf(polygon.about(ticker))).toEqual([aggsUrl(ticker, 2025)]);
        expect(urlsOf(yahoo.about(ticker))).toEqual([chartUrl(ticker, 2025)]);
      }
    });
  });

  describe("the per-user lookup budget", () => {
    test("sheds the eleventh lookup in a minute, for the user wherever they call from", async () => {
      const { polygon, yahoo } = stack.upstream;
      polygon.setTicker("XBUDGET", { bars: [{ date: "2025-03-03", close: 1 }] });
      const { client } = await createUserClient(stack, "closes-budget");
      const from = (ip: string) => ({ headers: { "X-Real-IP": ip } });

      // One served from Polygon, nine that find nothing anywhere: ten lookups that reached the gate.
      expect((await closes(client, "XBUDGET", "2025-03-03", "2025-03-03", from("10.6.0.1"))).body).toEqual({
        bars: [flat("2025-03-03", 1)],
      });
      for (let i = 1; i <= 9; i++) {
        expect((await closes(client, `XSPEND${i}`, "2025-03-03", "2025-03-03", from("10.6.0.1"))).body).toEqual({
          message: `No Yahoo data found for XSPEND${i}`,
        });
      }

      const shed = await closes(client, "XSPEND10", "2025-03-03", "2025-03-03", from("10.6.0.1"));
      expect(shed.status).toBe(200);
      expect(shed.json).toEqual(answered({ message: "Too many ticker lookups, try again in a minute." }));
      expect(polygon.about("XSPEND10")).toEqual([]);
      expect(yahoo.about("XSPEND10")).toEqual([]);
      // The budget is the user's, not the address's.
      expect((await closes(client, "XSPEND10", "2025-03-03", "2025-03-03", from("10.6.0.2"))).body).toEqual({
        message: "Too many ticker lookups, try again in a minute.",
      });
      expect((await closes(client, "XBUDGET", "2024-03-03", "2024-03-03", from("10.6.0.2"))).body).toEqual({
        message: "Too many ticker lookups, try again in a minute.",
      });
      expect(polygon.about("XBUDGET")).toHaveLength(2);

      // What is in memory costs nothing: cached bars and remembered failures are still served.
      expect((await closes(client, "XBUDGET", "2025-03-03", "2025-03-03", from("10.6.0.1"))).body).toEqual({
        bars: [flat("2025-03-03", 1)],
      });
      expect((await closes(client, "XSPEND3", "2025-03-03", "2025-03-03", from("10.6.0.1"))).body).toEqual({
        message: "No Yahoo data found for XSPEND3",
      });
      // So does a request that fails validation.
      expect((await closes(client, "XSPEND10", "2025-03-04", "2025-03-03", from("10.6.0.1"))).json).toEqual({
        status: "failed",
        message: "from must not be after to",
      });

      // Another user at the same address has a budget of their own.
      const { client: other } = await createUserClient(stack, "closes-budget-other");
      expect((await closes(other, "XSPEND10", "2025-03-03", "2025-03-03", from("10.6.0.1"))).body).toEqual({
        message: "No Yahoo data found for XSPEND10",
      });
      expect(urlsOf(polygon.about("XSPEND10"))).toEqual([aggsUrl("XSPEND10", 2025)]);
      // And what that lookup found is in memory for the first user too.
      expect((await closes(client, "XSPEND10", "2025-03-03", "2025-03-03", from("10.6.0.1"))).body).toEqual({
        message: "No Yahoo data found for XSPEND10",
      });
      expect(polygon.about("XSPEND10")).toHaveLength(1);
    });

    test("counts a lookup whatever came of it", async () => {
      const { polygon } = stack.upstream;
      const { client } = await createUserClient(stack, "closes-budget-failures");
      polygon.respond({ endpoint: "aggs", times: 10 }, polygonAnswer.planLimit("not on this plan"));
      for (let i = 1; i <= 10; i++) {
        expect((await closes(client, `XFAIL${i}`, "2025-03-03", "2025-03-03")).body).toEqual({ message: "not on this plan" });
      }
      expect((await closes(client, "XFAIL11", "2025-03-03", "2025-03-03")).body).toEqual({
        message: "Too many ticker lookups, try again in a minute.",
      });
      expect(polygon.about("XFAIL11")).toEqual([]);
    });
  });
});

describe("GET /daily-closes without a Polygon API key", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ env: { POLYGON_API_KEY: undefined } });
    stack.upstream.hub.clearSeen();
  });
  afterAll(() => stack.stop());

  test("says the key is not configured and asks nobody, Yahoo included", async () => {
    const { polygon, yahoo } = stack.upstream;
    yahoo.setTicker("XKEYLESS", { bars: [{ date: "2025-03-03", close: 5 }] });
    const client = await newUser(stack);
    const expected = answered({ message: "Polygon API key not configured" });
    const result = await closes(client, "XKEYLESS", "2025-03-03", "2025-03-03");
    expect(result.status).toBe(200);
    expect(result.json).toEqual(expected);
    expect((await closes(client, "XKEYLESS", "2025-03-03", "2025-03-03")).json).toEqual(expected);
    expect((await closes(client, "XOTHER", "2024-03-03", "2025-03-03")).json).toEqual(expected);
    expect(polygon.seen()).toEqual([]);
    expect(yahoo.seen()).toEqual([]);
  });

  test("still validates the request first", async () => {
    const client = await newUser(stack);
    expect((await client.get("/daily-closes", { query: { ticker: "XKEYLESS" } })).json).toEqual({
      status: "failed",
      message: "Missing required parameter: from",
    });
    expect((await closes(stack.anonymous(), "XKEYLESS", "2025-03-03", "2025-03-03")).status).toBe(401);
  });

  test("remembers the answer per symbol and year, and charges only the first ask of each", async () => {
    const client = await newUser(stack);
    const expected = { message: "Polygon API key not configured" };
    // Ten different symbols spend the user's budget, key or no key.
    for (let i = 1; i <= 10; i++) {
      expect((await closes(client, `XKEY${i}`, "2025-03-03", "2025-03-03")).body).toEqual(expected);
    }
    expect((await closes(client, "XKEY11", "2025-03-03", "2025-03-03")).body).toEqual({
      message: "Too many ticker lookups, try again in a minute.",
    });
    // The ones already asked are answered from memory, free of charge.
    expect((await closes(client, "XKEY1", "2025-06-03", "2025-06-03")).body).toEqual(expected);
    // The same symbol in another year is a new lookup.
    expect((await closes(client, "XKEY1", "2024-06-03", "2024-06-03")).body).toEqual({
      message: "Too many ticker lookups, try again in a minute.",
    });
  });

  test("warns at start that prices are off", () => {
    expect(stack.logCount("POLYGON_API_KEY not set - stock price fetching will be disabled")).toBe(1);
  });
});

describe("GET /daily-closes with the rate gates on", () => {
  let stack: Stack;
  beforeAll(async () => {
    // A server start refreshes the benchmark's price, which would spend slots
    // of the gates under test. So the first start, gates off, finds the
    // benchmark on Polygon and stores its closes; the restart that turns the
    // gates on then has nothing to refresh, and every slot is the tests'.
    stack = await startStack({
      beforeStart: ({ upstream }) => {
        const recent = Array.from({ length: 10 }, (_, i) => new Date(Date.now() - (i + 1) * DAY_MS).toISOString().slice(0, 10));
        upstream.polygon.setTicker("VOO", { bars: recent.map((date) => ({ date, close: 600 })) });
      },
    });
    const { polygon, yahoo } = stack.upstream;
    const asked = polygon.seen().length + yahoo.seen().length;
    await stack.restart({ POLYGON_RATE_LIMIT_PER_MIN: "6", YAHOO_RATE_LIMIT_PER_MIN: "1" });
    expect(polygon.seen().length + yahoo.seen().length).toBe(asked);
    stack.upstream.hub.clearSeen();
  }, 60_000);
  afterAll(() => stack.stop());

  let client: ApiClient;
  const stillLoading = (ticker: string) =>
    answered({ message: `Prices for ${ticker} are still loading. Retry in a minute.`, retryable: true });
  const pair = (close: number) => [
    { date: "2025-03-03", close },
    { date: "2025-03-04", close: close + 1 },
  ];

  test("answers \"still loading\" when Yahoo's gate has no slot, and keeps fetching in the background", async () => {
    const { polygon, yahoo } = stack.upstream;
    client = await newUser(stack);
    yahoo.setTicker("XYA", { bars: pair(30) });
    yahoo.setTicker("XYB", { bars: pair(40) });

    // Yahoo's gate lets one request a minute through, and this is it.
    expect((await closes(client, "XYA", "2025-03-03", "2025-03-04")).body).toEqual({
      bars: [flat("2025-03-03", 30), flat("2025-03-04", 31)],
    });
    const started = Date.now();
    const shed = await closes(client, "XYB", "2025-03-03", "2025-03-04");
    expect(shed.status).toBe(200);
    expect(shed.json).toEqual(stillLoading("XYB"));
    // The slot frees long after the five seconds a watched request may wait, so it does not wait at all.
    expect(Date.now() - started).toBeLessThan(3_000);

    // The background fetch starts over, asks Polygon again, and queues at Yahoo's gate.
    await stack.waitFor(() => polygon.about("XYB").length === 2, { what: "the background fetch of XYB" });
    expect(urlsOf(polygon.about("XYB"))).toEqual([aggsUrl("XYB", 2025), aggsUrl("XYB", 2025)]);
    expect(yahoo.about("XYB")).toEqual([]);
    // While it runs, asking again costs nothing and starts nothing.
    expect((await closes(client, "XYB", "2025-03-03", "2025-03-04")).json).toEqual(stillLoading("XYB"));
    expect(polygon.about("XYB")).toHaveLength(2);
    expect(urlsOf(yahoo.seen())).toEqual([chartUrl("XYA", 2025)]);
  });

  test("answers \"still loading\" when Polygon's gate has no slot in time, and serves the bars once the background fetch lands", async () => {
    const { polygon, yahoo } = stack.upstream;
    const paying = { bars: pair(10), dividends: [{ exDate: "2025-03-04", cashAmount: 1 }] };
    polygon.setTicker("XGA", paying);
    polygon.setTicker("XGB", { bars: pair(20) });
    polygon.setTicker("XGC", { bars: pair(50) });
    polygon.setTicker("XGD", paying);
    const paid = { bars: [{ date: "2025-03-03", close: 10, adjustedClose: 10 * (1 - 1 / 10) }, flat("2025-03-04", 11)] };

    // Polygon's gate lets six requests a minute through. The test before took
    // three; these three (bars, dividends, splits) take the rest.
    expect((await closes(client, "XGA", "2025-03-03", "2025-03-04")).body).toEqual(paid);
    expect(polygon.seen()).toHaveLength(6);

    const started = Date.now();
    const shed = await closes(client, "XGB", "2025-03-03", "2025-03-04");
    expect(shed.status).toBe(200);
    expect(shed.json).toEqual(stillLoading("XGB"));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await closes(client, "XGB", "2025-03-03", "2025-03-04")).json).toEqual(stillLoading("XGB"));
    expect(polygon.about("XGB")).toEqual([]);

    // A minute after the first requests their slots free up, and both background fetches go through.
    await stack.waitFor(() => polygon.about("XGB").length === 2 && yahoo.about("XYB").length === 1, {
      timeoutMs: 90_000,
      what: "the gates to let the background fetches through",
    });
    await untilLoaded(stack, client, "XGB", "2025-03-03", "2025-03-04");
    await untilLoaded(stack, client, "XYB", "2025-03-03", "2025-03-04");
    expect((await closes(client, "XGB", "2025-03-03", "2025-03-04")).json).toEqual(
      answered({ bars: [flat("2025-03-03", 20), flat("2025-03-04", 21)] }),
    );
    expect((await closes(client, "XYB", "2025-03-03", "2025-03-04")).json).toEqual(
      answered({ bars: [flat("2025-03-03", 40), flat("2025-03-04", 41)] }),
    );
    // The watched requests made no call of their own; the background fetches made each once.
    expect(urlsOf(polygon.about("XGB"))).toEqual([aggsUrl("XGB", 2025), dividendsUrl("XGB", 2025)]);
    expect(urlsOf(yahoo.about("XYB"))).toEqual([chartUrl("XYB", 2025)]);
    expect(polygon.about("XYB")).toHaveLength(2);

    // A slot that frees within the five seconds is waited for: these three get theirs as the first minute's expire.
    expect((await closes(client, "XGD", "2025-03-03", "2025-03-04")).body).toEqual(paid);
    // The wait budget is one for the whole fetch: the bars get the last slot, the dividends none in time.
    expect((await closes(client, "XGC", "2025-03-03", "2025-03-04")).json).toEqual(stillLoading("XGC"));
    expect(urlsOf(polygon.about("XGC"))).toEqual([aggsUrl("XGC", 2025)]);
  }, 150_000);
});
