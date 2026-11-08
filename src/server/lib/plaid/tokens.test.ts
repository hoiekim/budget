import { describe, it, expect, mock } from "bun:test";
import type { MaskedUser } from "server";
import { exchangePublicToken } from "./tokens";
import type { ExchangePublicTokenDeps } from "./tokens";

// No mock.module calls in this file, on purpose — the seam is the injected
// `deps` argument (see tokens.ts), the same pattern transactions.test.ts
// uses: the fakes below are plain function mocks, visible only to these
// tests, and the real `getClient` stays in place for every other file.

type ExchangeRequestStub = { public_token: string };
type ExchangeResponseStub = {
  data: { access_token?: string; item_id?: string };
};

const user = { user_id: "u-1", username: "test" } as MaskedUser;

const makeDeps = (
  exchangeImpl: (request: ExchangeRequestStub) => Promise<ExchangeResponseStub>,
): ExchangePublicTokenDeps => {
  const mockGetClient = mock(() => ({ itemPublicTokenExchange: exchangeImpl }));
  // The stub client carries only the one method this function calls, not
  // the full PlaidApi shape — hence the cast.
  return { getClient: mockGetClient as unknown as ExchangePublicTokenDeps["getClient"] };
};

describe("exchangePublicToken", () => {
  it("returns the exchanged access_token and item_id, and passes the public token through", async () => {
    const seen: ExchangeRequestStub[] = [];
    const deps = makeDeps(async (request) => {
      seen.push(request);
      return { data: { access_token: "access-sandbox-1", item_id: "item-1" } };
    });

    const result = await exchangePublicToken(user, "public-sandbox-1", deps);

    expect(result).toEqual({ access_token: "access-sandbox-1", item_id: "item-1" });
    expect(seen).toEqual([{ public_token: "public-sandbox-1" }]);
  });

  it("propagates an exchange failure instead of answering with a partial token", async () => {
    const deps = makeDeps(async () => {
      throw new Error("INVALID_PUBLIC_TOKEN");
    });

    await expect(exchangePublicToken(user, "public-bad", deps)).rejects.toThrow(
      "INVALID_PUBLIC_TOKEN",
    );
  });

  it("returns malformed response.data unchanged — it does not validate the shape", async () => {
    // Pinning the current contract, not endorsing it: the caller
    // (`exchangePlaidToken` in post-public-token.ts) destructures
    // access_token/item_id from this return, so a shape missing either
    // surfaces as undefined downstream. Hardening the shape is a separate
    // change; this test exists so it cannot drift silently.
    const deps = makeDeps(async () => ({ data: {} }));

    const result = await exchangePublicToken(user, "public-sandbox-1", deps);

    expect(result).toEqual({});
  });
});
