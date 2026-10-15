/**
 * Daily closes over a date range, both as traded (split-adjusted only) and
 * dividend-adjusted. Polygon is the primary source, as everywhere else: its
 * aggregates are split-adjusted only, so the adjusted series is derived from
 * its dividend history. Yahoo's chart, which returns both series itself, is
 * the fallback for symbols Polygon has no bars for, chiefly mutual funds.
 */

import { DailyClose, JSONSecurity, QueueWaitTimeoutError } from "common";
import { logger } from "./logger";
import * as polygon from "./polygon";
import type { PolygonResult } from "./polygon";
import * as yahoo from "./yahoo";

export type { DailyClose };

export interface Dividend {
  /** YYYY-MM-DD */
  exDate: string;
  cashAmount: number;
}

interface Options {
  maxWaitMs?: number;
  securityType?: JSONSecurity["type"];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const POLYGON_HOST = "https://api.polygon.io";

/**
 * Per symbol, the bars from the start of the earliest year asked for through
 * the day of the fetch. Any later range inside it is served without a call,
 * and starting on a year boundary means a request can't force a fresh fetch
 * by asking from a day earlier. The rate gate is shared with the price refresh
 * and the backfill, which can hold it for minutes.
 */
const cache = new Map<string, { from: string; to: string; bars: DailyClose[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Failed fetches, briefly, so an unknown symbol doesn't spend calls on every retry. */
const failures = new Map<string, { result: PolygonResult<never>; failedAt: number }>();
const FAILURE_TTL_MS = 5 * 60 * 1000;

/** Fetches with no deadline still running, so a caller can wait for one instead of queueing another. */
const loading = new Map<string, Promise<PolygonResult<DailyClose[]>>>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) cache.delete(key);
  }
  for (const [key, entry] of failures) {
    if (now - entry.failedAt >= FAILURE_TTL_MS) failures.delete(key);
  }
}, CACHE_TTL_MS).unref();

export const clearDailyClosesCache = () => {
  cache.clear();
  failures.clear();
  loading.clear();
};

const toDateString = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Back-adjusts traded closes for cash dividends, the way providers build an
 * adjusted series: every close before an ex-date is scaled by
 * `1 - dividend / close on the last day before it`. Dividends after the range
 * scale every bar by the same factor, so leaving them out changes no ratio
 * between two bars in it.
 */
export const adjustForDividends = (
  bars: { date: string; close: number }[],
  dividends: Dividend[],
): DailyClose[] => {
  const adjusted: DailyClose[] = [];
  let factor = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    adjusted.push({ date: bar.date, close: bar.close, adjustedClose: bar.close * factor });
    const older = bars[i - 1];
    if (!older) break;
    for (const d of dividends) {
      if (d.exDate > older.date && d.exDate <= bar.date) factor *= 1 - d.cashAmount / older.close;
    }
  }
  return adjusted.reverse();
};

/**
 * Polygon's bars are adjusted for every split since, but its dividends are as
 * declared, so a dividend is restated per today's share by each later split.
 */
export const splitAdjust = (dividends: Dividend[], splits: { date: string; ratio: number }[]): Dividend[] =>
  dividends.map((d) => ({
    exDate: d.exDate,
    cashAmount: splits.reduce((amount, s) => (s.date > d.exDate ? amount / s.ratio : amount), d.cashAmount),
  }));

const polygonFailure = (err: unknown, ticker: string): PolygonResult<never> => {
  if (err instanceof QueueWaitTimeoutError) return polygon.rateLimitedResult(ticker);
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Polygon daily-closes error for ${ticker}: ${message}`, { component: "daily-closes" });
  return { success: false, error: "api_error", message: `Failed to fetch closes for ${ticker}: ${message}` };
};

const getPolygonJson = async (url: string, subject: string, maxWaitMs?: number) => {
  const response = await polygon.polygonQueue.add(() => polygon.fetchWithRetry(url), { maxWaitMs });
  const json = await response.json();
  const refusal = polygon.upstreamRefusal(response, json, subject);
  return { json, refusal };
};

const getPolygonDailyCloses = async (
  ticker_symbol: string,
  from: string,
  to: string,
  options: Options,
): Promise<PolygonResult<DailyClose[]>> => {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return { success: false, error: "no_api_key", message: "Polygon API key not configured" };
  const ticker = polygon.toPolygonTicker(ticker_symbol, options.securityType);
  const encoded = polygon.encodeTicker(ticker);
  // One budget across both calls, so a caller's wait covers the whole fetch.
  const deadline = options.maxWaitMs ? Date.now() + options.maxWaitMs : undefined;
  const remaining = () => (deadline === undefined ? undefined : Math.max(1, deadline - Date.now()));

  try {
    const aggs = await getPolygonJson(
      `${POLYGON_HOST}/v2/aggs/ticker/${encoded}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`,
      `${ticker} in [${from}, ${to}]`,
      remaining(),
    );
    if (aggs.refusal) return aggs.refusal;
    const results = (aggs.json.results ?? []) as { c: number; t: number }[];
    const bars = results
      .filter((r) => Number.isFinite(r.c) && r.c > 0)
      .map((r) => ({ date: toDateString(r.t), close: r.c }));
    if (!bars.length) {
      return { success: false, error: "no_data", message: `No daily closes for ${ticker} between ${from} and ${to}` };
    }

    const divs = await getPolygonJson(
      `${POLYGON_HOST}/v3/reference/dividends?ticker=${encodeURIComponent(ticker)}&ex_dividend_date.gte=${from}&ex_dividend_date.lte=${to}&limit=1000&apiKey=${apiKey}`,
      `${ticker} dividends`,
      remaining(),
    );
    if (divs.refusal) return divs.refusal;
    const declared = ((divs.json.results ?? []) as { ex_dividend_date?: string; cash_amount?: number }[])
      .filter((d) => typeof d.ex_dividend_date === "string" && typeof d.cash_amount === "number")
      .map((d) => ({ exDate: d.ex_dividend_date!, cashAmount: d.cash_amount! }));
    if (!declared.length) return { success: true, data: adjustForDividends(bars, declared) };

    const splitsResponse = await getPolygonJson(
      `${POLYGON_HOST}/v3/reference/splits?ticker=${encodeURIComponent(ticker)}&execution_date.gte=${from}&limit=1000&apiKey=${apiKey}`,
      `${ticker} splits`,
      remaining(),
    );
    if (splitsResponse.refusal) return splitsResponse.refusal;
    const splits = ((splitsResponse.json.results ?? []) as { execution_date?: string; split_from?: number; split_to?: number }[])
      .filter((s) => typeof s.execution_date === "string" && (s.split_from ?? 0) > 0 && (s.split_to ?? 0) > 0)
      .map((s) => ({ date: s.execution_date!, ratio: s.split_to! / s.split_from! }));

    return { success: true, data: adjustForDividends(bars, splitAdjust(declared, splits)) };
  } catch (err) {
    return polygonFailure(err, ticker);
  }
};

const getYahooDailyCloses = async (
  ticker_symbol: string,
  from: string,
  to: string,
  options: Options,
): Promise<PolygonResult<DailyClose[]>> => {
  const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const period2 = Math.floor((Date.parse(`${to}T00:00:00Z`) + DAY_MS) / 1000);
  const yahooTicker = yahoo.toYahooTicker(ticker_symbol, options.securityType);
  const chart = await yahoo.fetchChart(
    yahooTicker,
    `interval=1d&period1=${period1}&period2=${period2}`,
    options.maxWaitMs,
  );
  if (!chart.success) return chart;

  const timestamps = chart.data.timestamp ?? [];
  const closes = chart.data.indicators?.quote?.[0]?.close ?? [];
  const adjusted = chart.data.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: DailyClose[] = [];
  timestamps.forEach((t, i) => {
    const close = closes[i];
    const adjustedClose = adjusted[i];
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) return;
    if (typeof adjustedClose !== "number" || !Number.isFinite(adjustedClose) || adjustedClose <= 0) {
      return;
    }
    const date = yahoo.dateStringOfTimestamp(t);
    if (date < from || date > to) return;
    bars.push({ date, close, adjustedClose });
  });

  if (!bars.length) {
    return {
      success: false,
      error: "no_data",
      message: `No daily closes for ${ticker_symbol} between ${from} and ${to}`,
    };
  }
  return { success: true, data: bars };
};

const keyOf = (ticker_symbol: string, securityType?: JSONSecurity["type"]) => `${ticker_symbol}:${securityType ?? ""}`;
const yearStart = (date: string) => `${date.slice(0, 4)}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

const inRange = (
  bars: DailyClose[],
  ticker_symbol: string,
  from: string,
  to: string,
): PolygonResult<DailyClose[]> => {
  const within = bars.filter((b) => b.date >= from && b.date <= to);
  if (within.length) return { success: true, data: within };
  return { success: false, error: "no_data", message: `No daily closes for ${ticker_symbol} between ${from} and ${to}` };
};

export type DailyClosesPeek = PolygonResult<DailyClose[]> | "loading" | undefined;

/**
 * What a call would answer without reaching the rate gate: cached bars, a
 * recent failure, `"loading"` while a fetch for the symbol is still running,
 * or `undefined` when a call is needed.
 */
export const peekDailyCloses = (
  ticker_symbol: string,
  from: string,
  to: string,
  securityType?: JSONSecurity["type"],
): DailyClosesPeek => {
  const key = keyOf(ticker_symbol, securityType);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.from <= from && cached.to >= to) {
    return inRange(cached.bars, ticker_symbol, from, to);
  }
  const failed = failures.get(`${key}:${yearStart(from)}`);
  if (failed && Date.now() - failed.failedAt < FAILURE_TTL_MS) return failed.result;
  if (loading.has(key)) return "loading";
  return undefined;
};

const fetchWindow = async (
  ticker_symbol: string,
  from: string,
  options: Options,
): Promise<PolygonResult<DailyClose[]>> => {
  const key = keyOf(ticker_symbol, options.securityType);
  const windowFrom = yearStart(from);
  const to = today();
  let result = await getPolygonDailyCloses(ticker_symbol, windowFrom, to, options);
  if (!result.success && result.error === "no_data") {
    result = await getYahooDailyCloses(ticker_symbol, windowFrom, to, options);
  }
  if (result.success) {
    cache.set(key, { from: windowFrom, to, bars: result.data, fetchedAt: Date.now() });
  } else if (result.error !== "rate_limited") {
    failures.set(`${key}:${windowFrom}`, { result, failedAt: Date.now() });
  }
  return result;
};

/**
 * Starts a fetch with no deadline, if none is running for the symbol, so the
 * cache is warm when the caller asks again. Its result is only cached.
 */
export const warmDailyCloses = (ticker_symbol: string, from: string, securityType?: JSONSecurity["type"]) => {
  const key = keyOf(ticker_symbol, securityType);
  if (loading.has(key)) return;
  const pending = fetchWindow(ticker_symbol, from, { securityType })
    .catch((err) => polygonFailure(err, ticker_symbol))
    .finally(() => loading.delete(key));
  loading.set(key, pending);
};

/** `from` and `to` are YYYY-MM-DD and inclusive. Bars come back oldest first. */
export const getDailyCloses = async (
  ticker_symbol: string,
  from: string,
  to: string,
  options: Options = {},
): Promise<PolygonResult<DailyClose[]>> => {
  const peek = peekDailyCloses(ticker_symbol, from, to, options.securityType);
  if (peek === "loading") return polygon.rateLimitedResult(ticker_symbol);
  if (peek) return peek;
  const result = await fetchWindow(ticker_symbol, from, options);
  return result.success ? inRange(result.data, ticker_symbol, from, to) : result;
};
