/** Plaid's API. Tests script it through `hub.on(PLAID_HOSTS…)` or the helpers here. */
import type { UpstreamHub, UpstreamRequest } from "./hub";

export const PLAID_PRODUCTION_HOST = "production.plaid.com";
export const PLAID_DEVELOPMENT_HOST = "development.plaid.com";
export const PLAID_SANDBOX_HOST = "sandbox.plaid.com";
export const PLAID_HOSTS = [PLAID_PRODUCTION_HOST, PLAID_DEVELOPMENT_HOST, PLAID_SANDBOX_HOST] as const;

export class FakePlaid {
  constructor(private readonly hub: UpstreamHub) {}

  /** Every request any Plaid environment received, optionally for one path. */
  seen(path = ""): UpstreamRequest[] {
    return this.hub.requests.filter((r) => (PLAID_HOSTS as readonly string[]).includes(r.host) && r.path.startsWith(path));
  }
}
