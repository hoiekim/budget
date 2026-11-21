/** Yahoo Finance's chart API, the fallback for tickers Polygon does not carry. */
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const YAHOO_HOST = "query1.finance.yahoo.com";

export class FakeYahoo {
  constructor(private readonly hub: UpstreamHub) {
    // By default Yahoo knows no symbol either.
    hub.on(YAHOO_HOST, () =>
      jsonResponse(404, { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }),
    );
  }

  seen(path = ""): UpstreamRequest[] {
    return this.hub.seen(YAHOO_HOST, path);
  }
}
