import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { json, startFakeIssuer } from "test-issuer";
import * as realApiKeys from "./postgres/repositories/api_keys";
import * as realUsers from "./postgres/repositories/users";
import type { ResolvedApiKey } from "./postgres/repositories/api_keys";
import type { MaskedUser } from "./postgres/models/user";

// Snapshot real sibling-module exports before replacing them with
// per-test mocks. The mock factories spread the snap so non-mocked
// exports still resolve to real implementations — otherwise sibling
// tests that go through `repositories/index.ts` (barrel re-export)
// see partial modules and crash with "Export named 'writeUser' not
// found". The `afterAll` block re-mocks each module back to its real
// snapshot so the override doesn't leak to other test files.
const realApiKeysSnap = { ...realApiKeys };
const realUsersSnap = { ...realUsers };

const aliceUser: MaskedUser = { user_id: "u-1", username: "alice" };
const aliceKey: ResolvedApiKey = {
  key_id: "k-1",
  user_id: "u-1",
  scopes: ["transactions:suggest"],
};

const mockVerifyApiKey = mock(async (_plaintext: string): Promise<ResolvedApiKey | null> => null);
const mockGetMaskedUserById = mock(
  async (_id: string): Promise<MaskedUser | undefined> => undefined,
);
const mockGetUserByAuthSub = mock(
  async (_sub: string): Promise<MaskedUser | undefined> => undefined,
);

mock.module("./postgres/repositories/api_keys", () => ({
  ...realApiKeysSnap,
  verifyApiKey: mockVerifyApiKey,
}));
mock.module("./postgres/repositories/users", () => ({
  ...realUsersSnap,
  getMaskedUserById: mockGetMaskedUserById,
  getUserByAuthSub: mockGetUserByAuthSub,
}));

const { resolveBearerAuth } = await import("./bearer-auth");
const { configureSso } = await import("./sso");
const { Unavailable } = await import("./auth-client");

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
  mock.module("./postgres/repositories/api_keys", () => realApiKeysSnap);
  mock.module("./postgres/repositories/users", () => realUsersSnap);
  restoreLeaves();
});

beforeEach(() => {
  mockVerifyApiKey.mockReset();
  mockGetMaskedUserById.mockReset();
  mockGetUserByAuthSub.mockReset();
  mockVerifyApiKey.mockImplementation(async () => null);
  mockGetMaskedUserById.mockImplementation(async () => undefined);
  mockGetUserByAuthSub.mockImplementation(async () => undefined);
  configureSso(null);
  issuer.reset();
});

describe("resolveBearerAuth — short-circuit gates (verifyApiKey must NOT be called)", () => {
  test("returns null when cookie session is present", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);

    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer bk_xxxx",
      hasCookieSession: true,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(mockGetMaskedUserById).not.toHaveBeenCalled();
  });

  test("returns null when matched route has no requiredScope", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer bk_xxxx",
      hasCookieSession: false,
      requiredScope: undefined,
    });
    expect(result).toBeNull();
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  test("returns null when Authorization header is absent", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    const result = await resolveBearerAuth({
      authorizationHeader: undefined,
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  test("returns null for non-Bearer scheme (Basic auth)", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    const result = await resolveBearerAuth({
      authorizationHeader: "Basic dXNlcjpwYXNz",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  test("returns null for empty Bearer token", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer    ",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
    // We do reach the `slice` step but immediately bail on the trimmed empty
    // string — verifyApiKey must not be called with "".
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  test("treats Authorization header as array — takes the first entry", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);
    await resolveBearerAuth({
      authorizationHeader: ["Bearer bk_xxxx", "Bearer bk_other"],
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(mockVerifyApiKey).toHaveBeenCalledWith("bk_xxxx");
  });
});

describe("resolveBearerAuth — key resolution", () => {
  test("returns null when verifyApiKey returns null (invalid/revoked/expired key)", async () => {
    mockVerifyApiKey.mockImplementation(async () => null);
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);
    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer bk_invalid",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(1);
    expect(mockGetMaskedUserById).not.toHaveBeenCalled();
  });

  test("returns null when key lacks the required scope", async () => {
    mockVerifyApiKey.mockImplementation(async () => ({
      key_id: "k-1",
      user_id: "u-1",
      scopes: ["other:scope"],
    }));
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);
    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer bk_xxxx",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(1);
    // Don't waste a user lookup if scope is missing
    expect(mockGetMaskedUserById).not.toHaveBeenCalled();
  });

  test("returns null when the resolved user_id no longer exists", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    mockGetMaskedUserById.mockImplementation(async () => undefined);
    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer bk_xxxx",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
    expect(mockGetMaskedUserById).toHaveBeenCalledWith("u-1");
  });

  test("returns the user when all checks pass", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);
    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer bk_xxxx",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).not.toBeNull();
    expect(result!.user).toEqual(aliceUser);
  });

  test("passes the trimmed plaintext (after 'Bearer ') to verifyApiKey", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);
    await resolveBearerAuth({
      authorizationHeader: "Bearer   bk_padded_token  ",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(mockVerifyApiKey).toHaveBeenCalledWith("bk_padded_token");
  });

  test("requires an exact scope match — does not treat scopes as hierarchical", async () => {
    mockVerifyApiKey.mockImplementation(async () => ({
      key_id: "k-1",
      user_id: "u-1",
      scopes: ["transactions"],
    }));
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);
    const result = await resolveBearerAuth({
      authorizationHeader: "Bearer bk_xxxx",
      hasCookieSession: false,
      requiredScope: "transactions:suggest",
    });
    expect(result).toBeNull();
  });
});

describe("resolveBearerAuth — keys the identity provider issued", () => {
  const SCOPE = "transactions:suggest";
  const activeKey = (scope = SCOPE) =>
    json(200, { active: true, sub: "usr_alice", username: "alice", role: "user", scope, jti: "key_1" });
  const resolve = (ip?: string) =>
    resolveBearerAuth({
      authorizationHeader: "Bearer abc_key_1_secret",
      hasCookieSession: false,
      requiredScope: SCOPE,
      ip,
    });

  beforeEach(() => {
    configureSso(issuer.config(), { fetch: issuer.fetch });
    mockGetUserByAuthSub.mockImplementation(async (sub) => (sub === "usr_alice" ? aliceUser : undefined));
  });

  test("an active key with the route's scope, owned by a linked user, authenticates as that user", async () => {
    issuer.state.introspect = () => activeKey(`other:scope ${SCOPE}`);
    expect(await resolve("198.51.100.4")).toEqual({ user: aliceUser });
    const [call] = issuer.seen("/oauth/introspect");
    expect(call.form.get("token")).toBe("abc_key_1_secret");
    expect(call.headers.get("x-real-ip")).toBe("198.51.100.4");
    expect(mockGetUserByAuthSub).toHaveBeenCalledWith("usr_alice");
  });

  test("an address that is not an IP is not passed on", async () => {
    issuer.state.introspect = () => activeKey();
    expect(await resolve("unknown")).toEqual({ user: aliceUser });
    expect(issuer.seen("/oauth/introspect")[0].headers.get("x-real-ip")).toBeNull();
  });

  test("a key without the route's scope is refused", async () => {
    issuer.state.introspect = () => activeKey("transactions:read");
    expect(await resolve()).toBeNull();
  });

  test("a key whose owner has no user here is refused", async () => {
    issuer.state.introspect = () =>
      json(200, { active: true, sub: "usr_bob", username: "bob", role: "user", scope: SCOPE });
    expect(await resolve()).toBeNull();
  });

  test("an inactive key is refused", async () => {
    expect(await resolve()).toBeNull();
    expect(issuer.seen("/oauth/introspect")).toHaveLength(1);
  });

  test("an unreachable provider is reported, not taken as a refusal", async () => {
    issuer.state.down = true;
    await expect(resolve()).rejects.toBeInstanceOf(Unavailable);
  });

  test("budget's own keys are checked locally and never sent to the provider", async () => {
    mockVerifyApiKey.mockImplementation(async () => aliceKey);
    mockGetMaskedUserById.mockImplementation(async () => aliceUser);
    expect(await resolve()).toEqual({ user: aliceUser });

    mockVerifyApiKey.mockImplementation(async () => ({ ...aliceKey, scopes: [] }));
    expect(await resolve()).toBeNull();
    expect(issuer.state.seen).toEqual([]);
  });

  test("with single sign-on off, a key budget does not know is simply refused", async () => {
    configureSso(null);
    expect(await resolve()).toBeNull();
    expect(issuer.state.seen).toEqual([]);
  });
});
