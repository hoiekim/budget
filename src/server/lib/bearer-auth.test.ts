// Per-test-bundle isolation — see scripts/test-bundled/.
//
// `resolveBearerAuth` lost its `BearerAuthDeps` DI seam — it now calls
// `verifyApiKey` and `getMaskedUserById` directly. Both come from
// sibling files that are THEIR OWN `@bundles` targets, so a plain
// `mock.module(absPath, …)` would shadow those tests' source→bundle
// redirects (verified collision: bearer-auth's mock of api_keys.ts
// breaks api_keys.test.bundle.ts with N failures). `mockExternal`
// resolves to a per-test SHIM path so each test owns a distinct module
// identity for the same source — see scripts/test-bundled/build.ts.
// @bundles src/server/lib/bearer-auth.ts
// @external ./postgres/repositories/api_keys
// @external ./postgres/repositories/users
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { bundleOf } from "test-bundled";
import { mockExternal } from "test-bundled";
import type { ResolvedApiKey } from "./postgres/repositories/api_keys";
import type { MaskedUser } from "./postgres/models/user";

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

mockExternal(import.meta.url, "./postgres/repositories/api_keys", () => ({
  verifyApiKey: mockVerifyApiKey,
}));
mockExternal(import.meta.url, "./postgres/repositories/users", () => ({
  getMaskedUserById: mockGetMaskedUserById,
}));

const { resolveBearerAuth } = await bundleOf<typeof import("./bearer-auth")>(import.meta.url);

beforeEach(() => {
  mockVerifyApiKey.mockReset();
  mockGetMaskedUserById.mockReset();
  mockVerifyApiKey.mockImplementation(async () => null);
  mockGetMaskedUserById.mockImplementation(async () => undefined);
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
