/**
 * Daily closes over a date range, both as traded (split-adjusted only) and
 * dividend-adjusted. Polygon is the primary source, as everywhere else: its
 * aggregates are split-adjusted only, so the adjusted series is derived from
 * its dividend history. Yahoo's chart, which returns both series itself, is
 * the fallback for symbols Polygon has no bars for, chiefly mutual funds.
 */

import { JSONSecurity, QueueWaitTimeoutError } from "common";
import { logger } from "./logger";
import * as polygon from "./polygon";
import type { PolygonResult } from "./polygon";
import * as yahoo from "./yahoo";

export interface DailyClose {
  /** YYYY-MM-DD, the trading day the bar belongs to. */
  date: string;
  close: number;
  adjustedClose: number;
}

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
 * Per symbol, the bars from the earliest date asked for through the day of
 * the fetch, so any later range inside it is served without a call. The rate
 * gate is shared with the price refresh and the backfill, which can hold it
 * for minutes, so a repeated preview should not have to queue behind them.
 */
const cache = new Map<string, { from: string; to: string; bars: DailyClose[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) cache.delete(key);
  }
}, CACHE_TTL_MS).unref();

export const clearDailyClosesCache = () => cache.clear();

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

  try {
    const aggs = await getPolygonJson(
      `${POLYGON_HOST}/v2/aggs/ticker/${encoded}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`,
      `${ticker} in [${from}, ${to}]`,
      options.maxWaitMs,
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
      options.maxWaitMs,
    );
    if (divs.refusal) return divs.refusal;
    const dividends = ((divs.json.results ?? []) as { ex_dividend_date?: string; cash_amount?: number }[])
      .filter((d) => typeof d.ex_dividend_date === "string" && typeof d.cash_amount === "number")
      .map((d) => ({ exDate: d.ex_dividend_date!, cashAmount: d.cash_amount! }));

    return { success: true, data: adjustForDividends(bars, dividends) };
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

/** `from` and `to` are YYYY-MM-DD and inclusive. Bars come back oldest first. */
export const getDailyCloses = async (
  ticker_symbol: string,
  from: string,
  to: string,
  options: Options = {},
): Promise<PolygonResult<DailyClose[]>> => {
  const key = `${ticker_symbol}:${options.securityType ?? ""}`;
  const inRange = (bars: DailyClose[]) => bars.filter((b) => b.date >= from && b.date <= to);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.from <= from && cached.to >= to) {
    return { success: true, data: inRange(cached.bars) };
  }

  const today = new Date().toISOString().slice(0, 10);
  const fetchTo = to > today ? to : today;
  let result = await getPolygonDailyCloses(ticker_symbol, from, fetchTo, options);
  if (!result.success && result.error === "no_data") {
    result = await getYahooDailyCloses(ticker_symbol, from, fetchTo, options);
  }
  if (!result.success) return result;
  cache.set(key, { from, to: fetchTo, bars: result.data, fetchedAt: Date.now() });
  const bars = inRange(result.data);
  if (!bars.length) {
    return { success: false, error: "no_data", message: `No daily closes for ${ticker_symbol} between ${from} and ${to}` };
  }
  return { success: true, data: bars };
};
