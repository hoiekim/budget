/** A SimpleFin bridge. Tests script it through `hub.on(SIMPLEFIN_HOST, …)` or the helpers here. */
import type { UpstreamHub, UpstreamRequest } from "./hub";

export const SIMPLEFIN_HOST = "bridge.simplefin.test";
export const SIMPLEFIN_CLAIM_HOST = "claim.simplefin.test";

export class FakeSimpleFin {
  constructor(private readonly hub: UpstreamHub) {}

  seen(path = ""): UpstreamRequest[] {
    return this.hub.requests.filter(
      (r) => (r.host === SIMPLEFIN_HOST || r.host === SIMPLEFIN_CLAIM_HOST) && r.path.startsWith(path),
    );
  }
}
