/**
 * Yahoo Finance's chart API, the fallback for tickers Polygon does not carry
 * (mutual funds, chiefly).
 *
 * By default it knows no symbol and answers its 404 "no data" for
 * everything; every server start runs background jobs against it. A test
 * declares the symbols it wants and, where it needs Yahoo to refuse, queues
 * an answer:
 *
 *   const { yahoo } = stack.upstream;
 *   yahoo.setTicker("VFIAX", {
 *     longName: "Vanguard 500 Index Admiral",
 *     bars: [
 *       { date: "2026-03-02", close: 500, adjustedClose: 497.5 },
 *       { date: "2026-03-03", close: 501 },            // adjusted close = close
 *       { date: "2026-03-04", close: null },           // a day Yahoo has no close for
 *     ],
 *   });
 *   yahoo.respond({ ticker: "VFIAX", times: 1 }, yahooAnswer.rateLimited());
 *   …
 *   expect(urlsOf(yahoo.about("VFIAX"))).toEqual([…]);
 *
 * Like the real endpoint, it turns away a caller without a browser
 * `User-Agent`.
 */
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const YAHOO_HOST = "query1.finance.yahoo.com";

export interface YahooBar {
  /** YYYY-MM-DD, the trading day. */
  date: string;
  /** The close as traded; `null` is a day Yahoo lists without one. */
  close: number | null;
  /** The dividend-adjusted close; the close itself when left out, `null` for a hole. */
  adjustedClose?: number | null;
}

export interface YahooTicker {
  longName?: string;
  shortName?: string;
  /** `USD` when left out. */
  currency?: string;
  /** `MUTUALFUND` when left out. */
  instrumentType?: string;
  /** Daily bars, any order. A range without one answers a chart with no timestamps, as Yahoo does. */
  bars?: YahooBar[];
  /** Leave the adjusted series out of the answer altogether. */
  withoutAdjusted?: boolean;
}

/** A scripted answer to one request. */
export type YahooAnswer = (request: UpstreamRequest) => Response;

const NOT_FOUND = {
  chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } },
};

/**
 * Answers Yahoo gives instead of a chart, for `FakeYahoo.respond`.
 *
 *   yahoo.respond({ ticker: "VFIAX" }, yahooAnswer.rateLimited());
 *   yahoo.respond({ times: 1 }, yahooAnswer.status(502));
 */
export const yahooAnswer = {
  /** HTTP 429, the plain-text answer of Yahoo's edge to a caller it throttles. */
  rateLimited: (): YahooAnswer => () =>
    new Response("Too Many Requests\r\n", { status: 429, headers: { "Content-Type": "text/html" } }),

  /** HTTP 404 with the "no data" envelope: Yahoo does not know the symbol. This is also the default. */
  notFound: (): YahooAnswer => () => jsonResponse(404, NOT_FOUND),

  /** Any JSON body on any status. */
  json:
    (httpStatus: number, body: unknown): YahooAnswer =>
    () =>
      jsonResponse(httpStatus, body),

  /** A status with a body that is not JSON (an error page), or with none (`body: ""`). */
  status:
    (httpStatus: number, body = `<html><body><h1>${httpStatus}</h1></body></html>`, contentType = "text/html"): YahooAnswer =>
    () =>
      new Response(body, { status: httpStatus, headers: { "Content-Type": contentType } }),
};

/** When Yahoo stamps the daily bar of `date`: the New York open, in seconds. */
export const yahooBarTimestamp = (date: string): number => Date.parse(`${date}T14:30:00Z`) / 1000;

interface Scripted {
  ticker?: string;
  remaining: number;
  answer: YahooAnswer;
}

const CHART_PATH = /^\/v8\/finance\/chart\/([^/]+)$/;

/** The symbol a chart request names, or `undefined` for another path. */
const symbolOf = (request: UpstreamRequest): string | undefined => {
  const match = CHART_PATH.exec(request.path);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

export class FakeYahoo {
  private readonly tickers = new Map<string, YahooTicker>();
  private scripted: Scripted[] = [];

  constructor(private readonly hub: UpstreamHub) {
    // By default Yahoo knows no symbol either.
    hub.on(YAHOO_HOST, () => jsonResponse(404, NOT_FOUND));
    hub.on(YAHOO_HOST, (request) => this.answer(request));
  }

  /**
   * Declares what Yahoo knows about a symbol, replacing what it knew. Name it
   * as Yahoo does: a crypto pair is `BTC-USD`.
   *
   *   yahoo.setTicker("VFIAX", { longName: "Vanguard 500 Index Admiral", bars: [{ date: "2026-03-02", close: 500 }] });
   */
  setTicker(ticker: string, data: YahooTicker): void {
    this.tickers.set(ticker, data);
  }

  /** Forgets a symbol: Yahoo answers "no data" for it again. */
  removeTicker(ticker: string): void {
    this.tickers.delete(ticker);
  }

  /**
   * Queues `answer` for the chart requests that match: for `ticker` (any when
   * left out), for the next `times` requests (every one when left out). The
   * newest match wins. Returns the function that withdraws it.
   *
   *   const restore = yahoo.respond({ ticker: "VFIAX", times: 2 }, yahooAnswer.status(500));
   */
  respond(match: { ticker?: string; times?: number }, answer: YahooAnswer): () => void {
    const scripted: Scripted = { ticker: match.ticker, remaining: match.times ?? Infinity, answer };
    this.scripted.unshift(scripted);
    return () => {
      this.scripted = this.scripted.filter((s) => s !== scripted);
    };
  }

  /** Forgets every declared symbol and queued answer. */
  reset(): void {
    this.tickers.clear();
    this.scripted = [];
  }

  /** Every request Yahoo received, optionally only those whose path starts with `path`. */
  seen(path = ""): UpstreamRequest[] {
    return this.hub.seen(YAHOO_HOST, path);
  }

  /** The chart requests for one symbol, oldest first. */
  about(ticker: string): UpstreamRequest[] {
    return this.seen().filter((request) => symbolOf(request) === ticker);
  }

  private answer(request: UpstreamRequest): Response | undefined {
    const symbol = symbolOf(request);
    if (symbol === undefined) return undefined;
    // Yahoo throttles anything that does not look like a browser.
    if (!/^Mozilla\//.test(request.headers["user-agent"] ?? "")) return yahooAnswer.rateLimited()(request);
    const scripted = this.scripted.find((s) => s.remaining > 0 && (s.ticker === undefined || s.ticker === symbol));
    if (scripted) {
      scripted.remaining--;
      return scripted.answer(request);
    }
    const ticker = this.tickers.get(symbol);
    if (!ticker) return undefined;
    return jsonResponse(200, { chart: { result: [this.chart(request, symbol, ticker)], error: null } });
  }

  private chart(request: UpstreamRequest, symbol: string, ticker: YahooTicker): Record<string, unknown> {
    const { period1, period2, range } = request.query;
    const days = /^(\d+)d$/.exec(range ?? "");
    const since = period1 !== undefined ? Number(period1) : days ? Date.now() / 1000 - Number(days[1]) * 86_400 : -Infinity;
    const until = period2 !== undefined ? Number(period2) : Infinity;
    const bars = (ticker.bars ?? [])
      .map((bar) => ({ ...bar, timestamp: yahooBarTimestamp(bar.date) }))
      .filter((bar) => bar.timestamp >= since && bar.timestamp <= until)
      .sort((a, b) => a.timestamp - b.timestamp);
    const last = [...bars].reverse().find((bar) => bar.close !== null);
    const meta = {
      currency: ticker.currency ?? "USD",
      symbol,
      exchangeName: "NAS",
      fullExchangeName: "Nasdaq",
      instrumentType: ticker.instrumentType ?? "MUTUALFUND",
      ...(last ? { regularMarketPrice: last.close } : {}),
      ...(ticker.longName !== undefined ? { longName: ticker.longName } : {}),
      ...(ticker.shortName !== undefined ? { shortName: ticker.shortName } : {}),
      dataGranularity: "1d",
      range: range ?? "",
    };
    if (bars.length === 0) return { meta, indicators: { quote: [{}], adjclose: [{}] } };
    const closes = bars.map((bar) => bar.close);
    return {
      meta,
      timestamp: bars.map((bar) => bar.timestamp),
      indicators: {
        quote: [{ open: closes, high: closes, low: closes, close: closes, volume: bars.map(() => 0) }],
        ...(ticker.withoutAdjusted
          ? {}
          : { adjclose: [{ adjclose: bars.map((bar) => (bar.adjustedClose === undefined ? bar.close : bar.adjustedClose)) }] }),
      },
    };
  }
}
