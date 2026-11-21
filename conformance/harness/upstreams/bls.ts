/** The Bureau of Labor Statistics timeseries API, which the hourly CPI refresh calls. */
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const BLS_HOST = "api.bls.gov";

export class FakeBls {
  constructor(private readonly hub: UpstreamHub) {
    // By default BLS has nothing: every server start runs the refresh, and
    // most test files have no interest in it.
    hub.on(BLS_HOST, (request) => {
      if (request.path.startsWith("/publicAPI/")) {
        return jsonResponse(200, { status: "REQUEST_SUCCEEDED", message: [], Results: { series: [] } });
      }
      return undefined;
    });
  }

  seen(): UpstreamRequest[] {
    return this.hub.seen(BLS_HOST);
  }
}
