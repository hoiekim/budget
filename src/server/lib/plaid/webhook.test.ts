import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type * as jose from "jose";
import { MISSING_KEY_CACHE_TTL, createVerificationKeyLookup, verifyWebhook } from "./webhook";
import { plaidKeyFetchRateLimiter } from "../rate-limit";

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A JWT naming `kid`, signature irrelevant: verification stops at the key lookup. */
const jwtWithKid = (kid: string) =>
  `${base64url({ alg: "ES256", typ: "JWT", kid })}.${base64url({ iat: 0 })}.signature`;
/** Key fetches made so far in the current window: each one spends a slot of the process-wide cap. */
const fetchesMade = () => 10 - plaidKeyFetchRateLimiter.remaining("global");

describe("Plaid Webhook Verification", () => {
  it("should reject missing Plaid-Verification header", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, undefined);
    expect(result).toBe(false);
  });

  it("should reject empty Plaid-Verification header", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, "");
    expect(result).toBe(false);
  });

  it("should reject malformed JWT", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, "not.a.valid.jwt");
    expect(result).toBe(false);
  });

  it("should reject JWT without key_id", async () => {
    // JWT with no kid in header: {"alg":"ES256","typ":"JWT"}
    const noKidJwt = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, noKidJwt);
    expect(result).toBe(false);
  });

  // Note: Full integration tests with real Plaid signatures would require
  // a test webhook from Plaid or mocking the key fetch. These unit tests
  // verify the rejection of invalid inputs.
});

// Plaid isn't configured in the test environment, so every fetch fails the way
// an unknown key_id does: these exercise the miss path end to end.
describe("Plaid webhook verification key lookups", () => {
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
  beforeEach(() => plaidKeyFetchRateLimiter.reset("global"));

  it("asks for a key_id that didn't resolve only once, then remembers the miss", async () => {
    const jwt = jwtWithKid(`unknown-${crypto.randomUUID()}`);
    expect(await verifyWebhook(body, jwt)).toBe(false);
    expect(await verifyWebhook(body, jwt)).toBe(false);
    expect(fetchesMade()).toBe(1);
  });

  it("shares one fetch between concurrent requests for the same key_id", async () => {
    const jwt = jwtWithKid(`unknown-${crypto.randomUUID()}`);
    expect(await Promise.all([verifyWebhook(body, jwt), verifyWebhook(body, jwt), verifyWebhook(body, jwt)])).toEqual([
      false,
      false,
      false,
    ]);
    expect(fetchesMade()).toBe(1);
  });

  it("asks again for a different key_id", async () => {
    await verifyWebhook(body, jwtWithKid(`unknown-${crypto.randomUUID()}`));
    await verifyWebhook(body, jwtWithKid(`unknown-${crypto.randomUUID()}`));
    expect(fetchesMade()).toBe(2);
  });

  it("stops fetching once the process-wide cap is reached", async () => {
    for (let i = 0; i < 10; i++) await verifyWebhook(body, jwtWithKid(`unknown-${crypto.randomUUID()}`));
    const refused = jwtWithKid(`unknown-${crypto.randomUUID()}`);
    expect(await verifyWebhook(body, refused)).toBe(false);
    // A key_id refused at the cap was never asked for, so it isn't remembered as a miss:
    // once the window clears, it costs a fetch like any new one.
    plaidKeyFetchRateLimiter.reset("global");
    await verifyWebhook(body, refused);
    expect(fetchesMade()).toBe(1);
  });
});

describe("createVerificationKeyLookup", () => {
  const KEY = { kty: "EC", crv: "P-256", x: "x", y: "y" } as jose.JWK;
  let calls: string[] = [];
  /** A fetcher whose answers the test settles by hand, so concurrent lookups really overlap. */
  const deferredFetcher = () => {
    const pending: Array<{ resolve: (key: jose.JWK) => void; reject: (error: Error) => void }> = [];
    const fetchKey = (keyId: string) =>
      new Promise<jose.JWK>((resolve, reject) => {
        calls.push(keyId);
        pending.push({ resolve, reject });
      });
    return { fetchKey, pending };
  };

  beforeEach(() => {
    calls = [];
    plaidKeyFetchRateLimiter.reset("global");
  });
  afterEach(() => setSystemTime());

  it("shares one fetch between lookups that overlap", async () => {
    const { fetchKey, pending } = deferredFetcher();
    const lookup = createVerificationKeyLookup(fetchKey);
    const lookups = [lookup("k1"), lookup("k1"), lookup("k1")];
    pending[0].resolve(KEY);
    expect(await Promise.all(lookups)).toEqual([KEY, KEY, KEY]);
    expect(calls).toEqual(["k1"]);
  });

  it("remembers a failed fetch for the miss TTL, then asks again", async () => {
    const { fetchKey, pending } = deferredFetcher();
    const lookup = createVerificationKeyLookup(fetchKey);
    const start = Date.now();
    setSystemTime(start);
    const first = lookup("k2");
    pending[0].reject(new Error("unknown key"));
    expect(await first).toBeNull();
    expect(await lookup("k2")).toBeNull();
    expect(calls).toEqual(["k2"]);

    setSystemTime(start + MISSING_KEY_CACHE_TTL + 1);
    const retry = lookup("k2");
    pending[1].resolve(KEY);
    expect(await retry).toEqual(KEY);
    expect(calls).toEqual(["k2", "k2"]);
  });
});
