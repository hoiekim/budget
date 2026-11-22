/**
 * The Bureau of Labor Statistics timeseries API, which the hourly CPI refresh
 * calls: `POST /publicAPI/v1/timeseries/data/` without a registration key,
 * `/publicAPI/v2/…` with one.
 *
 * By default it succeeds with no series, since every server start runs the
 * refresh and most test files have no interest in it. A test declares the
 * series it wants and, where it needs BLS to refuse, says so:
 *
 *   const { bls } = stack.upstream;
 *   bls.setSeries("CUUR0000SA0", [
 *     { year: 2025, month: 9, value: 324.8 },
 *     { year: 2025, month: 10, value: "-" },     // a month BLS could not publish
 *     { year: 2025, month: 11, value: 324.122 },
 *     { year: 2025, month: 13, value: 322.0 },   // the annual average
 *   ]);
 *   bls.setRegistrationKeys(["conformance-bls-key"]);   // v2 refuses any other key
 *   bls.setDailyLimit(3);                               // the 4th request from now on: "daily threshold"
 *   bls.respond({ times: 1 }, blsAnswer.status(503));
 *   …
 *   expect(bls.seen().map((r) => r.json)).toEqual([{ seriesid: ["CUUR0000SA0"], startyear: "2025", endyear: "2026" }]);
 *
 * The two versions differ as the real ones do: v1 ignores a registration key
 * and serves at most 10 years a request, v2 serves 20.
 */
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const BLS_HOST = "api.bls.gov";

export interface BlsObservation {
  year: number;
  /** 1-12; 13 is the annual average, which BLS lists as period `M13`. */
  month: number;
  /** A number is written with three decimals, as BLS does; a string goes out as it is (`"-"` for an unpublished month). */
  value: number | string;
}

/** A scripted answer to one request. */
export type BlsAnswer = (request: UpstreamRequest) => Response;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December", "Annual",
];

const refused = (status: string, messages: string[]): Response =>
  jsonResponse(200, { status, responseTime: 0, message: messages, Results: {} });

/**
 * Answers BLS gives instead of data, for `FakeBls.respond`.
 *
 *   bls.respond({ times: 1 }, blsAnswer.dailyThreshold());
 *   bls.respond({}, blsAnswer.refused("REQUEST_FAILED_INVALID_PARAMETERS", ["Invalid Series"]));
 */
export const blsAnswer = {
  /** HTTP 200 `REQUEST_NOT_PROCESSED`: the day's request allowance is spent. */
  dailyThreshold: (): BlsAnswer => () =>
    refused("REQUEST_NOT_PROCESSED", [
      "The daily threshold for total number of requests allocated to the user has been reached.",
    ]),

  /** HTTP 200 with a status other than `REQUEST_SUCCEEDED` and BLS's messages. */
  refused:
    (status: string, messages: string[]): BlsAnswer =>
    () =>
      refused(status, messages),

  /** Any JSON body on any status. */
  json:
    (httpStatus: number, body: unknown): BlsAnswer =>
    () =>
      jsonResponse(httpStatus, body),

  /** A status with a body that is not JSON (an error page), or with none (`body: ""`). */
  status:
    (httpStatus: number, body = `<html><body><h1>${httpStatus}</h1></body></html>`, contentType = "text/html"): BlsAnswer =>
    () =>
      new Response(body, { status: httpStatus, headers: { "Content-Type": contentType } }),
};

interface Scripted {
  remaining: number;
  answer: BlsAnswer;
}

const PATH = /^\/publicAPI\/(v1|v2)\/timeseries\/data\/?$/;

/** The widest span of years one request is served, per API version. */
const MAX_YEARS = { v1: 10, v2: 20 } as const;

export class FakeBls {
  private readonly series = new Map<string, BlsObservation[]>();
  private scripted: Scripted[] = [];
  private keys: Set<string> | null = null;
  private allowance: number | null = null;

  constructor(private readonly hub: UpstreamHub) {
    hub.on(BLS_HOST, (request) => {
      if (request.path.startsWith("/publicAPI/")) return this.answer(request);
      return undefined;
    });
  }

  /**
   * Declares a series' observations, replacing what it had; any order.
   *
   *   bls.setSeries("CUUR0000SA0", [{ year: 2026, month: 1, value: 320.5 }]);
   */
  setSeries(seriesId: string, observations: BlsObservation[]): void {
    this.series.set(seriesId, observations);
  }

  /**
   * The registration keys v2 accepts; any other key, or none, is refused as
   * BLS refuses an invalid one. `null` (the default) accepts every key. v1
   * never looks at the key.
   */
  setRegistrationKeys(keys: string[] | null): void {
    this.keys = keys === null ? null : new Set(keys);
  }

  /**
   * How many more requests BLS serves before answering its "daily threshold"
   * refusal to each one after; `null` (the default) never refuses. A request
   * that is refused or answered by `respond` does not count.
   */
  setDailyLimit(remaining: number | null): void {
    this.allowance = remaining;
  }

  /**
   * Queues `answer` for the next `times` requests (every one when left out).
   * The newest wins. Returns the function that withdraws it.
   *
   *   bls.respond({ times: 1 }, blsAnswer.status(503));
   */
  respond(match: { times?: number }, answer: BlsAnswer): () => void {
    const scripted: Scripted = { remaining: match.times ?? Infinity, answer };
    this.scripted.unshift(scripted);
    return () => {
      this.scripted = this.scripted.filter((s) => s !== scripted);
    };
  }

  /** Forgets every series, key, limit and queued answer. */
  reset(): void {
    this.series.clear();
    this.scripted = [];
    this.keys = null;
    this.allowance = null;
  }

  /** Every request BLS received, oldest first; `json` is the posted body. */
  seen(): UpstreamRequest[] {
    return this.hub.seen(BLS_HOST);
  }

  private answer(request: UpstreamRequest): Response | undefined {
    const scripted = this.scripted.find((s) => s.remaining > 0);
    if (scripted) {
      scripted.remaining--;
      return scripted.answer(request);
    }
    const version = PATH.exec(request.path)?.[1] as "v1" | "v2" | undefined;
    if (!version || request.method !== "POST") {
      return jsonResponse(200, { status: "REQUEST_SUCCEEDED", message: [], Results: { series: [] } });
    }

    const body = (request.json ?? {}) as { seriesid?: unknown; startyear?: unknown; endyear?: unknown; registrationkey?: unknown };
    if (version === "v2" && this.keys !== null && !(typeof body.registrationkey === "string" && this.keys.has(body.registrationkey))) {
      return refused("REQUEST_NOT_PROCESSED", [`The key:${String(body.registrationkey ?? "")} provided by the User is invalid.`]);
    }
    if (this.allowance !== null) {
      if (this.allowance <= 0) return blsAnswer.dailyThreshold()(request);
      this.allowance--;
    }

    const ids = Array.isArray(body.seriesid) ? body.seriesid.map(String) : [];
    const messages: string[] = [];
    const endYear = Number(body.endyear);
    let startYear = Number(body.startyear);
    if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear > endYear) {
      return refused("REQUEST_FAILED_INVALID_PARAMETERS", ["Invalid year range"]);
    }
    if (endYear - startYear + 1 > MAX_YEARS[version]) {
      startYear = endYear - MAX_YEARS[version] + 1;
      messages.push(`Year range has been reduced to the system-allowed limit of ${MAX_YEARS[version]} years.`);
    }

    // With nothing declared at all, BLS has nothing: the default every boot-time refresh meets.
    const series = (this.series.size > 0 ? ids : []).map((id) => {
      const known = this.series.get(id);
      if (!known) messages.push(`Series does not exist for Series ${id}`);
      // Newest first, as BLS lists them.
      const rows = (known ?? [])
        .filter((o) => o.year >= startYear && o.year <= endYear)
        .sort((a, b) => b.year - a.year || b.month - a.month);
      const latest = rows.find((o) => o.month <= 12);
      return {
        seriesID: id,
        data: rows.map((o) => ({
          year: String(o.year),
          period: `M${String(o.month).padStart(2, "0")}`,
          periodName: MONTH_NAMES[o.month - 1] ?? "",
          ...(o === latest ? { latest: "true" } : {}),
          value: typeof o.value === "number" ? o.value.toFixed(3) : o.value,
          footnotes: [{}],
        })),
      };
    });
    return jsonResponse(200, { status: "REQUEST_SUCCEEDED", responseTime: 12, message: messages, Results: { series } });
  }
}
