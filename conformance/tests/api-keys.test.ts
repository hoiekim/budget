import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createUserClient, startStack, type ApiClient, type SeededUser, type Stack } from "../harness";

let stack: Stack;
let alice: { user: SeededUser; client: ApiClient };
let bob: { user: SeededUser; client: ApiClient };
beforeAll(async () => {
  stack = await startStack();
  alice = await createUserClient(stack, "keys-alice");
  bob = await createUserClient(stack, "keys-bob");
});
afterAll(() => stack.stop());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PLAINTEXT = /^bk_[A-Za-z0-9_-]{43}$/;
const SCOPE = "transactions:suggest";
const NOT_AUTHENTICATED = { status: "failed", message: "Not authenticated." };

interface Created {
  key_id: string;
  prefix: string;
  plaintext: string;
}

interface Listed {
  key_id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

const create = async (client: ApiClient, body: Record<string, unknown> = {}): Promise<Created> => {
  const result = await client.post<Created>("/api-keys", { name: "a key", scopes: [SCOPE], ...body });
  expect(result.json.status).toBe("success");
  return result.body;
};

const list = async (client: ApiClient): Promise<Listed[]> => (await client.get<{ api_keys: Listed[] }>("/api-keys")).body.api_keys;

/** A user of their own, so a test's keys are the only ones it lists. */
const newUser = async (name: string) => createUserClient(stack, `keys-${name}`);

describe("POST /api-keys", () => {
  test("refuses an anonymous caller", async () => {
    const result = await stack.anonymous().post("/api-keys", { name: "x", scopes: [SCOPE] });
    expect(result.status).toBe(401);
    expect(result.json).toEqual(NOT_AUTHENTICATED);
    expect(await stack.db.rows("api_keys", { name: "x" })).toEqual([]);
  });

  test("issues a key, shows its plaintext once, and stores only its hash and prefix", async () => {
    const { user, client } = await newUser("issue");
    const before = Date.now();
    const result = await client.post<Created>("/api-keys", { name: "My laptop", scopes: [SCOPE] });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: "success",
      body: {
        key_id: expect.stringMatching(UUID),
        prefix: expect.stringMatching(/^bk_[A-Za-z0-9_-]{8}$/),
        plaintext: expect.stringMatching(PLAINTEXT),
      },
    });
    const { key_id, prefix, plaintext } = result.body;
    expect(prefix).toBe(plaintext.slice(0, 11));

    const rows = await stack.db.rows("api_keys", { user_id: user.user_id });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.key_id).toBe(key_id);
    expect(row.name).toBe("My laptop");
    expect(row.key_hash).toBe(createHash("sha256").update(plaintext).digest("hex"));
    expect(row.key_prefix).toBe(prefix);
    expect(row.scopes).toEqual([SCOPE]);
    expect(row.last_used_at).toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(row.expires_at).toBeNull();
    expect((row.created_at as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((row.created_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // The plaintext is in no column.
    expect(JSON.stringify(row)).not.toContain(plaintext);

    // The list never shows it again, nor the hash.
    const listed = await client.get("/api-keys");
    expect(listed.text).not.toContain(plaintext);
    expect(listed.text).not.toContain(row.key_hash as string);
  });

  test("two keys never share a plaintext, a hash or an id", async () => {
    const { client } = await newUser("unique");
    const first = await create(client);
    const second = await create(client);
    expect(second.plaintext).not.toBe(first.plaintext);
    expect(second.key_id).not.toBe(first.key_id);
  });

  describe("the body", () => {
    const notJson = "Body must be JSON.";
    const badName = "name is required and must be a non-empty string.";
    const cases: [string, unknown, string][] = [
      ["a JSON null", null, notJson],
      ["a JSON zero", 0, notJson],
      ["a JSON false", false, notJson],
      ["an empty JSON string", "", notJson],
      // Anything else that is not an object simply has no name.
      ["a number", 5, badName],
      ["a string", "name", badName],
      ["true", true, badName],
      ["an empty array", [], badName],
      ["an array holding a valid body", [{ name: "x", scopes: [SCOPE] }], badName],
      ["an empty object", {}, badName],
    ];
    for (const [what, body, message] of cases) {
      test(`refuses ${what}`, async () => {
        const result = await alice.client.post("/api-keys", body);
        expect(result.status).toBe(200);
        expect(result.json).toEqual({ status: "failed", message });
      });
    }

    test("refuses no body, a body that is not JSON, and JSON not labeled as JSON", async () => {
      const none = await alice.client.request("POST", "/api-keys");
      expect(none.json).toEqual({ status: "failed", message: notJson });
      const broken = await alice.client.request("POST", "/api-keys", {
        rawBody: '{"name": "x", "scopes": [',
        headers: { "Content-Type": "application/json" },
      });
      expect(broken.json).toEqual({ status: "failed", message: notJson });
      const unlabeled = await alice.client.request("POST", "/api-keys", {
        rawBody: JSON.stringify({ name: "x", scopes: [SCOPE] }),
        headers: { "Content-Type": "text/plain" },
      });
      expect(unlabeled.json).toEqual({ status: "failed", message: notJson });
    });
  });

  describe("name", () => {
    const required = "name is required and must be a non-empty string.";
    const cases: [string, unknown][] = [
      ["absent", undefined],
      ["null", null],
      ["a number", 7],
      ["a boolean", true],
      ["an array", ["a"]],
      ["an object", { a: 1 }],
      ["empty", ""],
      ["only spaces", "   "],
      ["only white space of other kinds", "\t\n\r   ﻿"],
    ];
    for (const [what, name] of cases) {
      test(`refuses a name that is ${what}`, async () => {
        const result = await alice.client.post("/api-keys", { name, scopes: [SCOPE] });
        expect(result.status).toBe(200);
        expect(result.json).toEqual({ status: "failed", message: required });
      });
    }

    test("is named first when the scopes and the expiry are wrong too", async () => {
      const result = await alice.client.post("/api-keys", { name: "", scopes: "no", expires_at: 5 });
      expect(result.json).toEqual({ status: "failed", message: required });
    });

    test("takes 255 characters and refuses 256, counted before trimming and in UTF-16 units", async () => {
      const { user, client } = await newUser("name-length");
      const tooLong = { status: "failed", message: "name must be 255 characters or fewer." };
      expect((await client.post("/api-keys", { name: "n".repeat(256), scopes: [SCOPE] })).json).toEqual(tooLong);
      // 255 after trimming is still 256 as sent.
      expect((await client.post("/api-keys", { name: `${"n".repeat(255)} `, scopes: [SCOPE] })).json).toEqual(tooLong);
      // 128 characters outside the basic plane are 256 units.
      expect((await client.post("/api-keys", { name: "🔑".repeat(128), scopes: [SCOPE] })).json).toEqual(tooLong);
      // The length is checked before the scopes.
      expect((await client.post("/api-keys", { name: "n".repeat(256), scopes: [] })).json).toEqual(tooLong);
      expect(await stack.db.rows("api_keys", { user_id: user.user_id })).toEqual([]);

      await create(client, { name: "n".repeat(255) });
      await create(client, { name: `${"🔑".repeat(127)}k` });
      const names = (await stack.db.rows("api_keys", { user_id: user.user_id }, "created_at")).map((row) => row.name);
      expect(names).toEqual(["n".repeat(255), `${"🔑".repeat(127)}k`]);
    });

    test("is stored trimmed, with what is inside it kept", async () => {
      const { user, client } = await newUser("name-trim");
      await create(client, { name: "  \t Zoë's  “CLI”  key  \n" });
      const rows = await stack.db.rows("api_keys", { user_id: user.user_id });
      expect(rows.map((row) => row.name)).toEqual(["Zoë's  “CLI”  key"]);
      expect((await list(client)).map((key) => key.name)).toEqual(["Zoë's  “CLI”  key"]);
    });

    test("keeps a next-line character, which is not white space to `String.prototype.trim`", async () => {
      const { user, client } = await newUser("name-next-line");
      await create(client, { name: "\u0085" });
      await create(client, { name: " \u0085 padded \u0085 " });
      const rows = await stack.db.rows("api_keys", { user_id: user.user_id }, "created_at");
      expect(rows.map((row) => row.name)).toEqual(["\u0085", "\u0085 padded \u0085"]);
    });

    test("may repeat: names are labels, not identifiers", async () => {
      const { client } = await newUser("name-repeat");
      const first = await create(client, { name: "same" });
      const second = await create(client, { name: "same" });
      expect((await list(client)).map((key) => key.key_id).sort()).toEqual([first.key_id, second.key_id].sort());
    });
  });

  describe("scopes", () => {
    const required = "scopes must be a non-empty string array.";
    const cases: [string, unknown, string][] = [
      ["absent", undefined, required],
      ["null", null, required],
      ["a string", SCOPE, required],
      ["a number", 1, required],
      ["an object", { 0: SCOPE }, required],
      ["an empty array", [], required],
      ["an array with a number in it", [SCOPE, 1], required],
      ["an array with a null in it", [null], required],
      ["an array with an array in it", [[SCOPE]], required],
      ["an unknown scope", ["transactions:read"], "Unknown scope: transactions:read"],
      ["a known scope followed by an unknown one", [SCOPE, "admin"], "Unknown scope: admin"],
      ["two unknown scopes: the first is named", ["one", "two"], "Unknown scope: one"],
      ["an empty scope", [""], "Unknown scope: "],
      ["a scope in another letter case", ["Transactions:Suggest"], "Unknown scope: Transactions:Suggest"],
      ["a scope with a space around it", [` ${SCOPE}`], `Unknown scope:  ${SCOPE}`],
    ];
    for (const [what, scopes, message] of cases) {
      test(`refuses ${what}`, async () => {
        const result = await alice.client.post("/api-keys", { name: "scoped", scopes });
        expect(result.status).toBe(200);
        expect(result.json).toEqual({ status: "failed", message });
      });
    }

    test("are named before a wrong expiry", async () => {
      const result = await alice.client.post("/api-keys", { name: "scoped", scopes: [], expires_at: 5 });
      expect(result.json).toEqual({ status: "failed", message: required });
    });

    test("are stored as given, a repeated scope included", async () => {
      const { user, client } = await newUser("scopes-stored");
      await create(client, { scopes: [SCOPE, SCOPE] });
      const rows = await stack.db.rows("api_keys", { user_id: user.user_id });
      expect(rows[0].scopes).toEqual([SCOPE, SCOPE]);
      expect((await list(client))[0].scopes).toEqual([SCOPE, SCOPE]);
    });
  });

  describe("expires_at", () => {
    const notString = "expires_at must be an ISO timestamp string.";
    const notValid = "expires_at is not a valid ISO timestamp.";
    const past = "expires_at must be in the future.";
    const cases: [string, unknown, string][] = [
      ["a number", Date.now() + 86_400_000, notString],
      ["zero", 0, notString],
      ["a boolean", true, notString],
      ["false", false, notString],
      ["an array", ["2099-01-01T00:00:00.000Z"], notString],
      ["an object", { at: "2099-01-01T00:00:00.000Z" }, notString],
      ["an empty string", "", notValid],
      ["words", "tomorrow", notValid],
      ["a month that is not on the calendar", "2099-13-01T00:00:00.000Z", notValid],
      ["a day no month has", "2099-01-32", notValid],
      ["a time that is not on the clock", "2099-01-01T25:00:00.000Z", notValid],
      ["a timestamp with something after it", "2099-01-01T00:00:00.000Z tail", notValid],
      ["a past instant", "2001-09-09T01:46:40.000Z", past],
      ["the epoch", "1970-01-01T00:00:00.000Z", past],
      ["a past date", "2020-01-01", past],
    ];
    for (const [what, expires_at, message] of cases) {
      test(`refuses ${what}`, async () => {
        const result = await alice.client.post("/api-keys", { name: "expiring", scopes: [SCOPE], expires_at });
        expect(result.status).toBe(200);
        expect(result.json).toEqual({ status: "failed", message });
      });
    }

    test("refuses the present moment", async () => {
      const result = await alice.client.post("/api-keys", {
        name: "expiring",
        scopes: [SCOPE],
        expires_at: new Date(Date.now() - 1).toISOString(),
      });
      expect(result.json).toEqual({ status: "failed", message: past });
    });

    test("null and absent both mean the key does not expire", async () => {
      const { user, client } = await newUser("no-expiry");
      await create(client, { expires_at: null });
      await create(client);
      const rows = await stack.db.rows("api_keys", { user_id: user.user_id });
      expect(rows.map((row) => row.expires_at)).toEqual([null, null]);
      expect((await list(client)).map((key) => key.expires_at)).toEqual([null, null]);
    });

    test("stores the instant, whatever way it was written", async () => {
      const { user, client } = await newUser("expiry-formats");
      // Read the way `Date.parse` reads them: a date alone is UTC, a date and
      // time with no zone is local time, and a day past the end of its month
      // rolls into the next one.
      const written = [
        "2099-03-04T05:06:07.089Z",
        "2099-03-04T05:06:07Z",
        "2099-03-04T05:06:07.5+05:30",
        "2099-03-04T05:06:07-08:00",
        "2099-03-04T05:06:07+0100",
        "2099-03-04T05:06:07.123456Z",
        "2099-03-04T24:00:00Z",
        "2099-03-04",
        "2099-03",
        "2099",
        "2099-03-04T05:06",
        "2099-03-04T05:06:07",
        "2099-03-04 05:06:07",
        "2099-02-30T00:00:00.000Z",
        "2099-04-31",
        "+002099-03-04T05:06:07Z",
        "2099-03-04t05:06:07z",
        "Wed, 04 Mar 2099 05:06:07 GMT",
        "Mar 4, 2099",
        "2099/03/04",
        "03/04/2099",
        "2099-3-4",
      ];
      for (const expires_at of written) {
        const instant = Date.parse(expires_at);
        expect(Number.isNaN(instant)).toBe(false);
        const created = await create(client, { name: expires_at, expires_at });
        const row = await stack.db.one("SELECT expires_at FROM api_keys WHERE key_id = $1", [created.key_id]);
        expect((row?.expires_at as Date).getTime()).toBe(instant);
      }
      const listed = await list(client);
      expect(listed).toHaveLength(written.length);
      for (const name of written) {
        expect(listed.find((key) => key.name === name)?.expires_at).toBe(new Date(Date.parse(name)).toISOString());
      }
      expect(await stack.db.rows("api_keys", { user_id: user.user_id })).toHaveLength(written.length);
    });

    test("refuses what `Date.parse` cannot read", async () => {
      const unreadable = [
        "  2099-03-04T05:06:07Z  ",
        "4102444800000",
        "2099-03-04T5:06:07Z",
        "2099-03-04T05:06:07 Z",
        "2099-03-04T05:06:07.Z",
        "2099-03-04T05:06:60Z",
        "2099-03-04T05:60:00Z",
        "2099-03-04T24:00:01Z",
        "2099-03-04T05:06:07+24:00",
        "2099-03-04T05:06:07+05",
        "2099-00-10",
        "2099-01-00",
      ];
      for (const expires_at of unreadable) {
        expect(Number.isNaN(Date.parse(expires_at))).toBe(true);
        const result = await alice.client.post("/api-keys", { name: "expiring", scopes: [SCOPE], expires_at });
        expect(result.json).toEqual({ status: "failed", message: notValid });
      }
    });

    test("takes an instant a moment from now", async () => {
      const { client } = await newUser("expiry-soon");
      const soon = new Date(Date.now() + 60_000).toISOString();
      const created = await create(client, { expires_at: soon });
      expect((await list(client)).find((key) => key.key_id === created.key_id)?.expires_at).toBe(soon);
    });
  });

  test("ignores fields it does not know, and a user_id above all", async () => {
    const { user, client } = await newUser("extra-fields");
    const created = await create(client, {
      user_id: bob.user.user_id,
      key_id: "00000000-0000-4000-8000-000000000000",
      key_hash: "f".repeat(64),
      revoked_at: "2001-01-01T00:00:00.000Z",
      last_used_at: "2001-01-01T00:00:00.000Z",
    });
    const row = (await stack.db.rows("api_keys", { key_id: created.key_id }))[0];
    expect(row.user_id).toBe(user.user_id);
    expect(row.key_hash).not.toBe("f".repeat(64));
    expect(row.revoked_at).toBeNull();
    expect(row.last_used_at).toBeNull();
    expect(await stack.db.rows("api_keys", { key_id: "00000000-0000-4000-8000-000000000000" })).toEqual([]);
  });
});

describe("GET /api-keys", () => {
  test("refuses an anonymous caller", async () => {
    const result = await stack.anonymous().get("/api-keys");
    expect(result.status).toBe(401);
    expect(result.json).toEqual(NOT_AUTHENTICATED);
  });

  test("is an empty list for a user with no keys", async () => {
    const { client } = await newUser("none");
    const result = await client.get("/api-keys");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: { api_keys: [] } });
  });

  test("lists the caller's keys, newest first, with everything but the hash", async () => {
    const { user, client } = await newUser("list");
    const expires = "2099-12-31T23:59:59.999Z";
    const first = await create(client, { name: "first" });
    const second = await create(client, { name: "second", expires_at: expires });
    const third = await create(client, { name: "third", scopes: [SCOPE, SCOPE] });
    const result = await client.get<{ api_keys: Listed[] }>("/api-keys");
    expect(result.status).toBe(200);
    const key = (created: Created, name: string, extra: Partial<Listed> = {}) => ({
      key_id: created.key_id,
      user_id: user.user_id,
      name,
      key_prefix: created.prefix,
      scopes: [SCOPE],
      created_at: expect.stringMatching(ISO),
      last_used_at: null,
      revoked_at: null,
      expires_at: null,
      ...extra,
    });
    expect(result.json).toEqual({
      status: "success",
      body: {
        api_keys: [
          key(third, "third", { scopes: [SCOPE, SCOPE] }),
          key(second, "second", { expires_at: expires }),
          key(first, "first"),
        ],
      },
    });
    const stored = await stack.db.rows("api_keys", { user_id: user.user_id }, "created_at DESC");
    expect(result.body.api_keys.map((listed) => listed.created_at)).toEqual(
      stored.map((row) => (row.created_at as Date).toISOString()),
    );
  });

  test("shows when a key was last used and leaves out nothing else for it", async () => {
    const { client } = await newUser("last-used");
    const created = await create(client);
    const used = new Date(Date.now() - 3_600_000);
    await stack.db.query("UPDATE api_keys SET last_used_at = $2 WHERE key_id = $1", [created.key_id, used]);
    expect((await list(client))[0].last_used_at).toBe(used.toISOString());
  });

  test("keeps listing a key that has expired, and stops listing one that was revoked", async () => {
    const { client } = await newUser("expired-listed");
    const expired = await create(client, { name: "expired" });
    const revoked = await create(client, { name: "revoked" });
    const yesterday = new Date(Date.now() - 86_400_000);
    await stack.db.query("UPDATE api_keys SET expires_at = $2 WHERE key_id = $1", [expired.key_id, yesterday]);
    await stack.db.query("UPDATE api_keys SET revoked_at = $2 WHERE key_id = $1", [revoked.key_id, yesterday]);
    const listed = await list(client);
    expect(listed.map((key) => key.name)).toEqual(["expired"]);
    expect(listed[0].expires_at).toBe(yesterday.toISOString());
  });

  test("never lists another user's keys", async () => {
    const mine = await newUser("mine");
    const theirs = await newUser("theirs");
    const key = await create(theirs.client, { name: "theirs" });
    expect(await list(mine.client)).toEqual([]);
    expect((await list(theirs.client)).map((listed) => listed.key_id)).toEqual([key.key_id]);
  });

  test("ignores a query string", async () => {
    const mine = await newUser("query");
    const theirs = await newUser("query-other");
    await create(theirs.client);
    const result = await mine.client.get("/api-keys", { query: { user_id: theirs.user.user_id, key_id: "x" } });
    expect(result.json).toEqual({ status: "success", body: { api_keys: [] } });
  });
});

describe("DELETE /api-keys", () => {
  test("refuses an anonymous caller", async () => {
    const key = await create(alice.client);
    const result = await stack.anonymous().delete("/api-keys", { query: { key_id: key.key_id } });
    expect(result.status).toBe(401);
    expect(result.json).toEqual(NOT_AUTHENTICATED);
    expect((await stack.db.rows("api_keys", { key_id: key.key_id }))[0].revoked_at).toBeNull();
  });

  test("names what is wrong with key_id", async () => {
    const cases: [string | undefined, string][] = [
      [undefined, "Missing required parameter: key_id"],
      ["key_id=", "Parameter key_id cannot be empty"],
      ["key_id=%20%20", "Parameter key_id cannot be empty"],
      ["key_id=%09%0A", "Parameter key_id cannot be empty"],
      // A byte-order mark is white space to `String.prototype.trim`.
      ["key_id=%EF%BB%BF%E2%80%83", "Parameter key_id cannot be empty"],
      ["key_id=a&key_id=b", "Parameter key_id must be a single value, not an array"],
      ["key_id=&key_id=", "Parameter key_id must be a single value, not an array"],
      ["KEY_ID=abc", "Missing required parameter: key_id"],
    ];
    for (const [query, message] of cases) {
      const result = await alice.client.delete(`/api-keys${query ? `?${query}` : ""}`);
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ status: "failed", message });
    }
  });

  test("revokes the caller's key: it is kept, marked, and no longer listed", async () => {
    const { client } = await newUser("revoke");
    const kept = await create(client, { name: "kept" });
    const key = await create(client, { name: "revoked" });
    const before = Date.now();
    const result = await client.delete("/api-keys", { query: { key_id: key.key_id } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: { revoked: true } });

    const row = (await stack.db.rows("api_keys", { key_id: key.key_id }))[0];
    expect(row.name).toBe("revoked");
    expect((row.revoked_at as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((row.revoked_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await stack.db.rows("api_keys", { key_id: kept.key_id }))[0].revoked_at).toBeNull();
    expect((await list(client)).map((listed) => listed.name)).toEqual(["kept"]);
  });

  test("says the same for a key already revoked, one that never existed, and one that is someone else's", async () => {
    const { client } = await newUser("revoke-twice");
    const notFound = { status: "failed", message: "Key not found or already revoked." };
    const key = await create(client);
    expect((await client.delete("/api-keys", { query: { key_id: key.key_id } })).json.status).toBe("success");
    const revokedAt = (await stack.db.rows("api_keys", { key_id: key.key_id }))[0].revoked_at as Date;

    const again = await client.delete("/api-keys", { query: { key_id: key.key_id } });
    expect(again.status).toBe(200);
    expect(again.json).toEqual(notFound);
    // The first revocation's time stands.
    expect(((await stack.db.rows("api_keys", { key_id: key.key_id }))[0].revoked_at as Date).getTime()).toBe(revokedAt.getTime());

    const unknown = await client.delete("/api-keys", { query: { key_id: "00000000-0000-4000-8000-000000000000" } });
    expect(unknown.json).toEqual(notFound);

    const theirs = await create(bob.client, { name: "bob's" });
    const foreign = await client.delete("/api-keys", { query: { key_id: theirs.key_id } });
    expect(foreign.json).toEqual(notFound);
    expect((await stack.db.rows("api_keys", { key_id: theirs.key_id }))[0].revoked_at).toBeNull();
    expect((await list(bob.client)).some((listed) => listed.key_id === theirs.key_id)).toBe(true);
  });

  test("reads the id in either letter case, and ignores other parameters", async () => {
    const { client } = await newUser("revoke-case");
    const key = await create(client);
    const result = await client.delete("/api-keys", {
      query: { key_id: key.key_id.toUpperCase(), user_id: bob.user.user_id },
    });
    expect(result.json).toEqual({ status: "success", body: { revoked: true } });
    expect((await stack.db.rows("api_keys", { key_id: key.key_id }))[0].revoked_at).not.toBeNull();
  });

  test("revokes a key that has already expired", async () => {
    const { client } = await newUser("revoke-expired");
    const key = await create(client);
    await stack.db.query("UPDATE api_keys SET expires_at = $2 WHERE key_id = $1", [key.key_id, new Date(Date.now() - 1000)]);
    expect((await client.delete("/api-keys", { query: { key_id: key.key_id } })).json).toEqual({
      status: "success",
      body: { revoked: true },
    });
    expect(await list(client)).toEqual([]);
  });
});


describe("what the database refuses", () => {
  const serverError = { status: "error", message: "Internal server error" };

  test("a key_id that is not a UUID fails as a server error, and raises the alarm", async () => {
    const { client } = await newUser("not-a-uuid");
    const key = await create(client);
    const result = await client.delete("/api-keys", { query: { key_id: "abc" } });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(serverError);
    // U+0085 is not white space to `String.prototype.trim`, so it is looked up, and is no UUID either.
    const nextLine = await client.delete("/api-keys?key_id=%C2%85");
    expect(nextLine.status).toBe(500);
    expect(nextLine.json).toEqual(serverError);
    expect((await list(client)).map((listed) => listed.key_id)).toEqual([key.key_id]);

    const title = "🚨 Budget Server Error: Route Error: DELETE /api-keys";
    const alarm = await stack.waitFor(() => stack.upstream.discord.alarms().find((a) => a.title === title), {
      what: "the route error alarm",
    });
    expect(alarm.description).toBe('**Error:** invalid input syntax for type uuid: "abc"');
  });

  test("a name the database cannot store fails as a server error, is logged, and raises the alarm", async () => {
    const { user, client } = await newUser("unstorable");
    const result = await client.post("/api-keys", { name: "nul\u0000inside", scopes: [SCOPE] });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(serverError);
    // An expiry `Date` can hold and the database cannot.
    const farFuture = await client.post("/api-keys", { name: "far", scopes: [SCOPE], expires_at: "+275760-09-13T00:00:00.000Z" });
    expect(farFuture.status).toBe(500);
    expect(farFuture.json).toEqual(serverError);
    expect(await stack.db.rows("api_keys", { user_id: user.user_id })).toEqual([]);

    const title = "🚨 Budget Server Error: Route Error: POST /api-keys";
    const alarm = await stack.waitFor(() => stack.upstream.discord.alarms().find((a) => a.title === title), {
      what: "the route error alarm",
    });
    expect(alarm.description).toBe('**Error:** invalid byte sequence for encoding "UTF8": 0x00');
    await stack.waitFor(
      () => stack.logs.filter((line) => line.includes("Failed to create API key") && line.includes(user.user_id)).length >= 2,
      { what: "the logged failures" },
    );
  });
});
