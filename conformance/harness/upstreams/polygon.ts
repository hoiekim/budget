/** Polygon's market-data API. Tests script it through `hub.on(POLYGON_HOST, …)` or the helpers here. */
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const POLYGON_HOST = "api.polygon.io";

export class FakePolygon {
  constructor(private readonly hub: UpstreamHub) {
    // By default Polygon carries nothing: a 404 is how it says so, and the
    // servers neither retry nor alarm on one.
    hub.on(POLYGON_HOST, () => jsonResponse(404, { status: "NOT_FOUND", message: "Ticker not found." }));
  }

  seen(path = ""): UpstreamRequest[] {
    return this.hub.seen(POLYGON_HOST, path);
  }
}
