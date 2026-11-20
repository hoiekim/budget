// The provider governs an account linked to it: once an event ends the
// person's access, neither the account's own password nor an API key budget
// issued to it gets them back in. Drives the event and then both doors
// against one stateful fake database, so each step sees what the last wrote.
import { describe, test, expect, mock, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { startFakeIssuer } from "test-issuer";

const PASSWORD = "correct-horse-battery-staple";
const PASSWORD_HASH = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
const KEY = "bk_" + "k".repeat(43);
const KEY_HASH = new Bun.CryptoHasher("sha256").update(KEY).digest("hex");

/** `admin`, linked to the provider's alice through AUTH_LINK_USERS. */
const admin = {
  user_id: "u-admin",
  username: "admin",
  password: PASSWORD_HASH,
  email: null,
  expiry: null,
  token: null,
  auth_sub: "usr_alice",
  updated: null,
  is_deleted: false,
};

let keyRevokedAt: string | null = null;

const keyRow = () => ({
  key_id: "key-1",
  user_id: admin.user_id,
  name: "script",
  key_hash: KEY_HASH,
  key_prefix: KEY.slice(0, 11),
  scopes: ["transactions:suggest"],
  created_at: "2026-11-01T00:00:00.000Z",
  last_used_at: null,
  revoked_at: keyRevokedAt,
  expires_at: null,
  updated: null,
});

const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });

const { driver } = createFakeSql(async (sql: string) => {
  const flat = sql.replace(/\s+/g, " ").trim();
  if (flat.startsWith("SELECT * FROM users")) return rows([admin]);
  if (flat.startsWith("SELECT * FROM api_keys")) return rows([keyRow()]);
  if (flat.startsWith("SELECT key_id, user_id, name")) return rows(keyRevokedAt ? [] : [keyRow()]);
  if (flat.startsWith("UPDATE api_keys") && flat.includes("revoked_at = $1")) {
    keyRevokedAt = new Date().toISOString();
    return rows([{ key_id: "key-1" }]);
  }
  return rows([]);
});
mock.module("../postgres/sql-driver", () => driver);

const { handleAuthEvent } = await import("./events");
const { resolveBearerAuth } = await import("server/lib/bearer-auth");
const { postLoginRoute } = await import("server/routes/users/post-login");
const { configureSso } = await import("server/lib/sso");

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
  restoreLeaves();
});

const signInWithPassword = () =>
  postLoginRoute.execute(
    {
      method: "POST",
      path: "/login",
      url: "http://x/api/login",
      headers: {},
      query: {},
      body: { username: "admin", password: PASSWORD },
      session: { id: "s-1", regenerate: (cb: () => void) => cb(), destroy() {} },
      ip: "203.0.113.20",
    } as unknown as Parameters<typeof postLoginRoute.execute>[0],
    {
      statusCode: 200,
      headersSent: false,
      status() {
        return this;
      },
      write: () => true,
      end() {},
    } as unknown as Parameters<typeof postLoginRoute.execute>[1],
  );

const useOwnKey = () =>
  resolveBearerAuth({
    authorizationHeader: `Bearer ${KEY}`,
    hasCookieSession: false,
    requiredScope: "transactions:suggest",
  });

describe("an account linked to the provider, during a migration", () => {
  test("signs in only with SSO, and loses budget's own keys when its access ends", async () => {
    configureSso(issuer.config({ localLogin: true }), { fetch: issuer.fetch });

    // Linked: its password is no way in while single sign-on is on.
    expect(await signInWithPassword()).toEqual({ status: "failed", message: "Invalid username or password." });
    // Its own key still works while it has access.
    expect((await useOwnKey())?.user.user_id).toBe(admin.user_id);

    await handleAuthEvent({ type: "user.disabled", jti: "evt_1", sub: "usr_alice" });

    expect(keyRevokedAt).not.toBeNull();
    expect(await useOwnKey()).toBeNull();
    expect(await signInWithPassword()).toEqual({ status: "failed", message: "Invalid username or password." });
  });

  test("with single sign-on off again, the password signs in as before", async () => {
    configureSso(null);
    expect((await signInWithPassword())?.status).toBe("success");
  });
});
