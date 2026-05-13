import { describe, test, expect, mock } from "bun:test";
import { resolveBearerAuth } from "./bearer-auth";
import type { ResolvedApiKey } from "./postgres/repositories/api_keys";
import type { MaskedUser } from "./postgres/models/user";

const aliceUser: MaskedUser = { user_id: "u-1", username: "alice" };
const aliceKey: ResolvedApiKey = {
  key_id: "k-1",
  user_id: "u-1",
  scopes: ["transactions:suggest"],
};

const makeDeps = ({
  resolved,
  user,
}: {
  resolved: ResolvedApiKey | null;
  user: MaskedUser | undefined;
}) => {
  const verifyApiKey = mock(async (_plaintext: string) => resolved);
  const getMaskedUserById = mock(async (_id: string) => user);
  return { verifyApiKey, getMaskedUserById };
};

describe("resolveBearerAuth — short-circuit gates (verifyApiKey must NOT be called)", () => {
  test("returns null when cookie session is present", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer bk_xxxx",
        hasCookieSession: true,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.verifyApiKey).not.toHaveBeenCalled();
    expect(deps.getMaskedUserById).not.toHaveBeenCalled();
  });

  test("returns null when matched route has no requiredScope", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer bk_xxxx",
        hasCookieSession: false,
        requiredScope: undefined,
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.verifyApiKey).not.toHaveBeenCalled();
  });

  test("returns null when Authorization header is absent", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: undefined,
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.verifyApiKey).not.toHaveBeenCalled();
  });

  test("returns null for non-Bearer scheme (Basic auth)", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Basic dXNlcjpwYXNz",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.verifyApiKey).not.toHaveBeenCalled();
  });

  test("returns null for empty Bearer token", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer    ",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
    // We do reach the `slice` step but immediately bail on the trimmed empty
    // string — verifyApiKey must not be called with "".
    expect(deps.verifyApiKey).not.toHaveBeenCalled();
  });

  test("treats Authorization header as array — takes the first entry", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    await resolveBearerAuth(
      {
        authorizationHeader: ["Bearer bk_xxxx", "Bearer bk_other"],
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(deps.verifyApiKey).toHaveBeenCalledWith("bk_xxxx");
  });
});

describe("resolveBearerAuth — key resolution", () => {
  test("returns null when verifyApiKey returns null (invalid/revoked/expired key)", async () => {
    const deps = makeDeps({ resolved: null, user: aliceUser });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer bk_invalid",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.verifyApiKey).toHaveBeenCalledTimes(1);
    expect(deps.getMaskedUserById).not.toHaveBeenCalled();
  });

  test("returns null when key lacks the required scope", async () => {
    const deps = makeDeps({
      resolved: { key_id: "k-1", user_id: "u-1", scopes: ["other:scope"] },
      user: aliceUser,
    });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer bk_xxxx",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.verifyApiKey).toHaveBeenCalledTimes(1);
    // Don't waste a user lookup if scope is missing
    expect(deps.getMaskedUserById).not.toHaveBeenCalled();
  });

  test("returns null when the resolved user_id no longer exists", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: undefined });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer bk_xxxx",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
    expect(deps.getMaskedUserById).toHaveBeenCalledWith("u-1");
  });

  test("returns the user when all checks pass", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer bk_xxxx",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.user).toEqual(aliceUser);
  });

  test("passes the trimmed plaintext (after 'Bearer ') to verifyApiKey", async () => {
    const deps = makeDeps({ resolved: aliceKey, user: aliceUser });
    await resolveBearerAuth(
      {
        authorizationHeader: "Bearer   bk_padded_token  ",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(deps.verifyApiKey).toHaveBeenCalledWith("bk_padded_token");
  });

  test("requires an exact scope match — does not treat scopes as hierarchical", async () => {
    const deps = makeDeps({
      resolved: { key_id: "k-1", user_id: "u-1", scopes: ["transactions"] },
      user: aliceUser,
    });
    const result = await resolveBearerAuth(
      {
        authorizationHeader: "Bearer bk_xxxx",
        hasCookieSession: false,
        requiredScope: "transactions:suggest",
      },
      deps,
    );
    expect(result).toBeNull();
  });
});
