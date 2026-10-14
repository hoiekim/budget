import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type * as jose from "jose";
import { UNKNOWN_KEY_CACHE_TTL, createVerificationKeyLookup, verifyWebhook } from "./webhook";
import { plaidKeyFetchRateLimiter } from "../rate-limit";

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A JWT naming `kid`, signature irrelevant: these tests stop at or before the key lookup. */
const jwtWithKid = (kid: string) =>
  `${base64url({ alg: "ES256", typ: "JWT", kid })}.${base64url({ iat: 0 })}.signature`;
const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
/** Every test passes its own lookup, so none of them can reach Plaid whatever the environment holds. */
const neverCalled = async (): Promise<never> => {
  throw new Error("no lookup expected");
};

describe("Plaid Webhook Verification", () => {
  it("should reject missing Plaid-Verification header", async () => {
    expect(await verifyWebhook(body, undefined, neverCalled)).toBe("invalid");
  });

  it("should reject empty Plaid-Verification header", async () => {
    expect(await verifyWebhook(body, "", neverCalled)).toBe("invalid");
  });

  it("should reject malformed JWT", async () => {
    expect(await verifyWebhook(body, "not.a.valid.jwt", neverCalled)).toBe("invalid");
  });

  it("should reject JWT without key_id", async () => {
    // JWT with no kid in header: {"alg":"ES256","typ":"JWT"}
    const noKidJwt = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
    expect(await verifyWebhook(body, noKidJwt, neverCalled)).toBe("invalid");
  });

  it("a key_id Plaid says doesn't exist is invalid", async () => {
    expect(await verifyWebhook(body, jwtWithKid("k"), async () => "unknown")).toBe("invalid");
  });

  it("a key that can't be fetched just now leaves the webhook unverifiable, not invalid", async () => {
    expect(await verifyWebhook(body, jwtWithKid("k"), async () => "unavailable")).toBe("unverifiable");
  });
});

describe("createVerificationKeyLookup", () => {
  const KEY = { kty: "EC", crv: "P-256", x: "x", y: "y" } as jose.JWK;
  const unknownKeyError = () =>
    Object.assign(new Error("Request failed with status code 400"), {
      response: { data: { error_code: "INVALID_WEBHOOK_VERIFICATION_KEY_ID" } },
    });
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
  /** A fetcher that answers at once: a key for `good-*`, unknown for anything else. */
  const instantFetcher = async (keyId: string) => {
    calls.push(keyId);
    if (keyId.startsWith("good-")) return KEY;
    throw unknownKeyError();
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

  it("keeps a key for an hour, then fetches it again", async () => {
    const lookup = createVerificationKeyLookup(instantFetcher);
    const start = Date.now();
    setSystemTime(start);
    expect(await lookup("good-1")).toEqual(KEY);
    setSystemTime(start + UNKNOWN_KEY_CACHE_TTL + 1);
    expect(await lookup("good-1")).toEqual(KEY);
    expect(calls).toEqual(["good-1"]);
    setSystemTime(start + 60 * 60 * 1000 + 1);
    expect(await lookup("good-1")).toEqual(KEY);
    expect(calls).toEqual(["good-1", "good-1"]);
  });

  it("remembers a key_id Plaid says doesn't exist for five minutes, then asks again", async () => {
    const lookup = createVerificationKeyLookup(instantFetcher);
    const start = Date.now();
    setSystemTime(start);
    expect(await lookup("bogus")).toBe("unknown");
    expect(await lookup("bogus")).toBe("unknown");
    expect(calls).toEqual(["bogus"]);
    setSystemTime(start + UNKNOWN_KEY_CACHE_TTL + 1);
    expect(await lookup("bogus")).toBe("unknown");
    expect(calls).toEqual(["bogus", "bogus"]);
  });

  it("doesn't remember any other fetch error, so the next webhook asks again", async () => {
    const { fetchKey, pending } = deferredFetcher();
    const lookup = createVerificationKeyLookup(fetchKey);
    const first = lookup("k2");
    pending[0].reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    expect(await first).toBe("unavailable");
    const retry = lookup("k2");
    pending[1].resolve(KEY);
    expect(await retry).toEqual(KEY);
    expect(calls).toEqual(["k2", "k2"]);
  });

  it("caps fetches of new key_ids, but a key that has verified before is fetched past the cap", async () => {
    const lookup = createVerificationKeyLookup(instantFetcher);
    const start = Date.now();
    setSystemTime(start);
    expect(await lookup("good-2")).toEqual(KEY);
    for (let i = 0; i < 9; i++) await lookup(`bogus-${i}`);
    expect(await lookup("bogus-over")).toBe("unavailable");
    expect(calls).not.toContain("bogus-over");
    // Cached answers come back whatever the cap says, a key and an unknown key_id alike.
    expect(await lookup("good-2")).toEqual(KEY);
    expect(await lookup("bogus-0")).toBe("unknown");
    expect(calls.filter((id) => id === "good-2" || id === "bogus-0")).toHaveLength(2);

    setSystemTime(start + 60 * 60 * 1000 + 1);
    plaidKeyFetchRateLimiter.consume("global", 10);
    expect(await lookup("good-2")).toEqual(KEY);
    expect(calls.filter((id) => id === "good-2")).toHaveLength(2);
  });
});
