/**
 * Polygon's market-data API: daily aggregates, ticker details, dividends and
 * splits.
 *
 * By default it carries nothing and answers 404 to everything, which the
 * servers neither retry nor alarm on; every server start runs background jobs
 * against it. A test declares the tickers it wants and, where it needs
 * Polygon to refuse, queues an answer:
 *
 *   const { polygon } = stack.upstream;
 *   polygon.setTicker("XPUB", {
 *     detail: { name: "Example Public Fund", currency_name: "usd" },
 *     bars: [{ date: "2026-03-02", close: 100 }, { date: "2026-03-03", close: 99 }],
 *     dividends: [{ exDate: "2026-03-03", cashAmount: 1 }],
 *     splits: [{ date: "2026-06-10", from: 1, to: 10 }],
 *   });
 *   polygon.respond({ ticker: "XPUB", endpoint: "aggs", times: 2 }, polygonAnswer.status(503));
 *   …
 *   expect(urlsOf(polygon.about("XPUB"))).toEqual([…]);
 */
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const POLYGON_HOST = "api.polygon.io";

/** The endpoints the servers call. */
export type PolygonEndpoint = "aggs" | "detail" | "dividends" | "splits";

export interface PolygonBar {
  /** YYYY-MM-DD, the trading day. */
  date: string;
  /** The close, split-adjusted as Polygon's aggregates are. */
  close: number;
}

export interface PolygonDividend {
  /** YYYY-MM-DD */
  exDate: string;
  /** Cash per share, as declared. */
  cashAmount: number;
}

export interface PolygonSplit {
  /** YYYY-MM-DD, the execution date. */
  date: string;
  /** `from` old shares became `to` new ones: a 10-for-1 split is `{ from: 1, to: 10 }`. */
  from: number;
  to: number;
}

export interface PolygonTicker {
  /** What `/v3/reference/tickers/{ticker}` knows; left out, that endpoint answers 404. */
  detail?: { name: string; currency_name?: string; type?: string; market?: string };
  /** Daily bars, any order. A range without one answers 200 with no `results`, as Polygon does. */
  bars?: PolygonBar[];
  dividends?: PolygonDividend[];
  splits?: PolygonSplit[];
}

/** A scripted answer to one request. */
export type PolygonAnswer = (request: UpstreamRequest) => Response;

const REQUEST_ID = "c0ffee00c0ffee00c0ffee00c0ffee00";

/**
 * Answers Polygon gives instead of data, for `FakePolygon.respond`.
 *
 *   polygon.respond({ ticker: "XPLAN" }, polygonAnswer.planLimit());
 *   polygon.respond({ endpoint: "splits", times: 1 }, polygonAnswer.rateLimited());
 *   polygon.respond({ ticker: "XDOWN", times: 3 }, polygonAnswer.status(502, "<html>Bad Gateway</html>"));
 */
export const polygonAnswer = {
  /** HTTP 403 `NOT_AUTHORIZED`: the plan does not cover what was asked. `message: null` leaves the message out. */
  planLimit:
    (
      message: string | null = "Your plan doesn't include this data timeframe. Please upgrade your plan at https://polygon.io/pricing",
    ): PolygonAnswer =>
    () =>
      jsonResponse(403, { status: "NOT_AUTHORIZED", request_id: REQUEST_ID, ...(message === null ? {} : { message }) }),

  /** HTTP 429 with Polygon's error envelope: the key's per-minute quota is spent. */
  rateLimited: (): PolygonAnswer => () =>
    jsonResponse(429, {
      status: "ERROR",
      request_id: REQUEST_ID,
      error:
        "You've exceeded the maximum requests per minute, please wait or upgrade your subscription to continue. https://polygon.io/pricing",
    }),

  /** The error envelope `{ status: "ERROR", error }`, on any HTTP status; Polygon also sends it on a 200. */
  error:
    (error: string | null = "Something went wrong", httpStatus = 200): PolygonAnswer =>
    () =>
      jsonResponse(httpStatus, { status: "ERROR", request_id: REQUEST_ID, ...(error === null ? {} : { error }) }),

  /** Any JSON body on any status. */
  json:
    (httpStatus: number, body: unknown): PolygonAnswer =>
    () =>
      jsonResponse(httpStatus, body),

  /** A status with a body that is not JSON (a gateway's error page), or with none (`body: ""`). */
  status:
    (httpStatus: number, body = `<html><body><h1>${httpStatus}</h1></body></html>`, contentType = "text/html"): PolygonAnswer =>
    () =>
      new Response(body, { status: httpStatus, headers: { "Content-Type": contentType } }),
};

/** When Polygon stamps the daily bar of `date`: the start of the session's day in New York, in milliseconds. */
export const polygonBarTimestamp = (date: string): number => Date.parse(`${date}T05:00:00Z`);

/** Requests as `METHOD /path?query` lines, for asserting exactly what a server asked. */
export const urlsOf = (requests: UpstreamRequest[]): string[] =>
  requests.map((r) => `${r.method} ${r.path}${r.search ? `?${r.search}` : ""}`);

interface Scripted {
  ticker?: string;
  endpoint?: PolygonEndpoint;
  remaining: number;
  answer: PolygonAnswer;
}

interface Asked {
  endpoint: PolygonEndpoint;
  ticker: string;
  from?: string;
  to?: string;
}

const AGGS_PATH = /^\/v2\/aggs\/ticker\/([^/]+)\/range\/1\/day\/([^/]+)\/([^/]+)$/;
const DETAIL_PATH = /^\/v3\/reference\/tickers\/([^/]+)$/;

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Which endpoint and ticker a request addresses; `undefined` for a path Polygon does not have. */
const asked = (request: UpstreamRequest): Asked | undefined => {
  const aggs = AGGS_PATH.exec(request.path);
  if (aggs) return { endpoint: "aggs", ticker: decode(aggs[1]), from: decode(aggs[2]), to: decode(aggs[3]) };
  const detail = DETAIL_PATH.exec(request.path);
  if (detail) return { endpoint: "detail", ticker: decode(detail[1]) };
  if (request.path === "/v3/reference/dividends") return { endpoint: "dividends", ticker: request.query.ticker ?? "" };
  if (request.path === "/v3/reference/splits") return { endpoint: "splits", ticker: request.query.ticker ?? "" };
  return undefined;
};

/** Whether `value` passes the `field.gte` / `.gt` / `.lte` / `.lt` / exact filters of a reference query. */
const passes = (query: Record<string, string>, field: string, value: string): boolean =>
  (query[field] === undefined || value === query[field]) &&
  (query[`${field}.gte`] === undefined || value >= query[`${field}.gte`]) &&
  (query[`${field}.gt`] === undefined || value > query[`${field}.gt`]) &&
  (query[`${field}.lte`] === undefined || value <= query[`${field}.lte`]) &&
  (query[`${field}.lt`] === undefined || value < query[`${field}.lt`]);

/** The URL of the page after `request`'s, to which a client adds its `apiKey` as it does for Polygon's own. */
const nextUrl = (request: UpstreamRequest, cursor: number): string => {
  const params = new URLSearchParams(request.search);
  params.delete("apiKey");
  params.set("cursor", String(cursor));
  return `https://${POLYGON_HOST}${request.path}?${params}`;
};

export class FakePolygon {
  private readonly tickers = new Map<string, PolygonTicker>();
  private scripted: Scripted[] = [];

  constructor(private readonly hub: UpstreamHub) {
    // By default Polygon carries nothing: a 404 is how it says so, and the
    // servers neither retry nor alarm on one.
    hub.on(POLYGON_HOST, () => jsonResponse(404, { status: "NOT_FOUND", message: "Ticker not found." }));
    hub.on(POLYGON_HOST, (request) => this.answer(request));
  }

  /**
   * Declares what Polygon knows about a ticker, replacing what it knew. Name
   * it as Polygon does: a crypto pair is `X:BTCUSD`.
   *
   *   polygon.setTicker("VOO", { bars: [{ date: "2026-03-02", close: 512.3 }] });
   */
  setTicker(ticker: string, data: PolygonTicker): void {
    this.tickers.set(ticker, data);
  }

  /** Forgets a ticker: Polygon answers 404 for it again. */
  removeTicker(ticker: string): void {
    this.tickers.delete(ticker);
  }

  /**
   * Queues `answer` for the requests that match: about `ticker` (any when
   * left out), to `endpoint` (any when left out), for the next `times`
   * requests (every one when left out). The newest match wins. Returns the
   * function that withdraws it.
   *
   *   const restore = polygon.respond({ ticker: "XPUB", endpoint: "dividends" }, polygonAnswer.rateLimited());
   *   …
   *   restore();
   */
  respond(match: { ticker?: string; endpoint?: PolygonEndpoint; times?: number }, answer: PolygonAnswer): () => void {
    const scripted: Scripted = { ticker: match.ticker, endpoint: match.endpoint, remaining: match.times ?? Infinity, answer };
    this.scripted.unshift(scripted);
    return () => {
      this.scripted = this.scripted.filter((s) => s !== scripted);
    };
  }

  /** Forgets every declared ticker and queued answer. */
  reset(): void {
    this.tickers.clear();
    this.scripted = [];
  }

  /** Every request Polygon received, optionally only those whose path starts with `path`. */
  seen(path = ""): UpstreamRequest[] {
    return this.hub.seen(POLYGON_HOST, path);
  }

  /** The requests about one ticker, to any endpoint (or only `endpoint`), oldest first. */
  about(ticker: string, endpoint?: PolygonEndpoint): UpstreamRequest[] {
    return this.seen().filter((request) => {
      const what = asked(request);
      return what !== undefined && what.ticker === ticker && (endpoint === undefined || what.endpoint === endpoint);
    });
  }

  private answer(request: UpstreamRequest): Response | undefined {
    const what = asked(request);
    if (!what) return undefined;
    if (!request.query.apiKey) {
      return jsonResponse(401, { status: "ERROR", request_id: REQUEST_ID, error: "API Key was not provided" });
    }
    const scripted = this.scripted.find(
      (s) => s.remaining > 0 && (s.ticker === undefined || s.ticker === what.ticker) && (s.endpoint === undefined || s.endpoint === what.endpoint),
    );
    if (scripted) {
      scripted.remaining--;
      return scripted.answer(request);
    }
    const ticker = this.tickers.get(what.ticker);
    if (!ticker) return undefined;
    switch (what.endpoint) {
      case "aggs":
        return this.aggregates(request, what, ticker);
      case "detail":
        return this.detail(what.ticker, ticker);
      case "dividends":
        return this.reference(
          request,
          (ticker.dividends ?? [])
            .filter((d) => passes(request.query, "ex_dividend_date", d.exDate))
            .sort((a, b) => (a.exDate < b.exDate ? 1 : -1))
            .map((d) => ({
              cash_amount: d.cashAmount,
              currency: "USD",
              dividend_type: "CD",
              ex_dividend_date: d.exDate,
              frequency: 4,
              pay_date: d.exDate,
              record_date: d.exDate,
              ticker: what.ticker,
            })),
        );
      case "splits":
        return this.reference(
          request,
          (ticker.splits ?? [])
            .filter((s) => passes(request.query, "execution_date", s.date))
            .sort((a, b) => (a.date < b.date ? 1 : -1))
            .map((s) => ({ execution_date: s.date, split_from: s.from, split_to: s.to, ticker: what.ticker })),
        );
    }
  }

  private aggregates(request: UpstreamRequest, what: Asked, ticker: PolygonTicker): Response {
    const { from = "", to = "" } = what;
    const bars = (ticker.bars ?? [])
      .filter((bar) => bar.date >= from && bar.date <= to)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (request.query.sort === "desc") bars.reverse();
    const adjusted = request.query.adjusted !== "false";
    if (bars.length === 0) {
      return jsonResponse(200, { ticker: what.ticker, queryCount: 0, resultsCount: 0, adjusted, status: "OK", request_id: REQUEST_ID });
    }
    const limit = Math.min(Number(request.query.limit) || 5000, 50000);
    const start = Number(request.query.cursor) || 0;
    const page = bars.slice(start, start + limit);
    const more = start + limit < bars.length;
    return jsonResponse(200, {
      ticker: what.ticker,
      queryCount: page.length,
      resultsCount: page.length,
      adjusted,
      results: page.map((bar) => ({
        v: 1_000_000,
        vw: bar.close,
        o: bar.close,
        c: bar.close,
        h: bar.close,
        l: bar.close,
        t: polygonBarTimestamp(bar.date),
        n: 1000,
      })),
      status: "OK",
      request_id: REQUEST_ID,
      count: page.length,
      ...(more ? { next_url: nextUrl(request, start + limit) } : {}),
    });
  }

  private detail(name: string, ticker: PolygonTicker): Response | undefined {
    if (!ticker.detail) return undefined;
    return jsonResponse(200, {
      request_id: REQUEST_ID,
      results: {
        ticker: name,
        name: ticker.detail.name,
        market: ticker.detail.market ?? "stocks",
        locale: "us",
        primary_exchange: "ARCX",
        type: ticker.detail.type ?? "ETF",
        active: true,
        currency_name: ticker.detail.currency_name ?? "usd",
      },
      status: "OK",
    });
  }

  /** A page of a reference list (dividends, splits), newest first, with `next_url` when `limit` cuts it short. */
  private reference(request: UpstreamRequest, results: unknown[]): Response {
    const limit = Math.min(Number(request.query.limit) || 10, 1000);
    const start = Number(request.query.cursor) || 0;
    const page = results.slice(start, start + limit);
    const more = start + limit < results.length;
    return jsonResponse(200, {
      results: page,
      status: "OK",
      request_id: REQUEST_ID,
      ...(more ? { next_url: nextUrl(request, start + limit) } : {}),
    });
  }
}
