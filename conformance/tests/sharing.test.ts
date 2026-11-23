import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, startStack, type ApiClient, type SeededUser, type Stack } from "../harness";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_A_UUID = "not-a-uuid";
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";

interface Person {
  user: SeededUser;
  client: ApiClient;
  masked: { user_id: string; username: string };
}

let counter = 0;
/** A fresh user, signed in. Each test makes its own, so groups never leak between tests. */
const person = async (name: string): Promise<Person> => {
  const username = `${name}-${++counter}`;
  const user = await createUser(stack, username);
  const client = await stack.login(username, user.password);
  return { user, client, masked: { user_id: user.user_id, username } };
};

const invite = async (from: Person, to: Person): Promise<string> => {
  const result = await from.client.post<{ invitation: { invitation_id: string } }>("/sharing/invitation", {
    username: to.masked.username,
  });
  expect(result.json.status).toBe("success");
  return result.body.invitation.invitation_id;
};

/** Puts `members` in one sharing group, through the routes: the first invites and each other accepts. */
const group = async (...members: Person[]): Promise<void> => {
  const [first, ...rest] = members;
  for (const member of rest) {
    const invitation_id = await invite(first, member);
    expect((await member.client.post("/sharing/member", { invitation_id })).json).toEqual({ status: "success" });
  }
};

const members = async (person: Person) =>
  (await person.client.get<{ members: unknown[]; invitations: unknown[] }>("/sharing")).body;

const groupRows = () =>
  stack.db.query<{ user_id: string; group_id: string }>("SELECT user_id::text, group_id::text FROM sharing_members ORDER BY user_id");

describe("the sharing routes refuse anonymous callers", () => {
  test("every one of them", async () => {
    const anonymous = stack.anonymous();
    for (const [method, path] of [
      ["GET", "/sharing"],
      ["POST", "/sharing/invitation"],
      ["DELETE", "/sharing/invitation"],
      ["POST", "/sharing/member"],
      ["DELETE", "/sharing/member"],
    ]) {
      const result = await anonymous.request(method, path);
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual({ status: "failed", message: "Not authenticated." });
    }
  });
});

describe("GET /sharing", () => {
  test("is empty for someone who shares with nobody", async () => {
    const alice = await person("alice");
    const result = await alice.client.get("/sharing");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: { members: [], invitations: [] } });
  });

  test("shows an open invitation to both people, and to nobody else", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    const invitation_id = await invite(alice, bob);
    const expected = { members: [], invitations: [{ invitation_id, inviter: alice.masked, invitee: bob.masked }] };
    expect(await members(alice)).toEqual(expected);
    expect(await members(bob)).toEqual(expected);
    expect(await members(carol)).toEqual({ members: [], invitations: [] });
  });

  test("lists a group's members by username, and the invitations any member sent", async () => {
    const [zed, amy, mid, out] = [await person("zed"), await person("amy"), await person("mid"), await person("out")];
    await group(zed, amy);
    const sent = await invite(amy, mid);
    const byZed = await invite(zed, out);
    const expected = {
      members: [amy.masked, zed.masked],
      invitations: [
        { invitation_id: sent, inviter: amy.masked, invitee: mid.masked },
        { invitation_id: byZed, inviter: zed.masked, invitee: out.masked },
      ].sort((a, b) => (a.invitee.username < b.invitee.username ? -1 : 1)),
    };
    expect(await members(zed)).toEqual(expected);
    expect(await members(amy)).toEqual(expected);
    // The invitee sees only the invitation sent to them.
    expect(await members(mid)).toEqual({ members: [], invitations: [{ invitation_id: sent, inviter: amy.masked, invitee: mid.masked }] });
  });
});

describe("POST /sharing/invitation", () => {
  test("refuses a body without a username string", async () => {
    const alice = await person("alice");
    for (const [body, message] of [
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      [{}, "Missing required field: username"],
      [{ username: null }, "Missing required field: username"],
      [{ username: 5 }, "Field username must be a string"],
      [{ username: ["bob"] }, "Field username must be a string"],
    ] as const) {
      expect((await alice.client.post("/sharing/invitation", body)).json).toEqual({ status: "failed", message });
    }
  });

  test("invites a user by username, trimmed, and stores the invitation", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    const result = await alice.client.post("/sharing/invitation", { username: `  ${bob.masked.username}\t` });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: "success",
      body: { invitation: { invitation_id: expect.stringMatching(UUID), inviter: alice.masked, invitee: bob.masked } },
    });
    const rows = await stack.db.query(
      "SELECT invitation_id::text, inviter_user_id::text, invitee_user_id::text FROM sharing_invitations WHERE inviter_user_id = $1",
      [alice.user.user_id],
    );
    expect(rows).toEqual([
      {
        invitation_id: (result.body as { invitation: { invitation_id: string } }).invitation.invitation_id,
        inviter_user_id: alice.user.user_id,
        invitee_user_id: bob.user.user_id,
      },
    ]);
  });

  test("answers a repeated invitation with the one already open", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    const first = await invite(alice, bob);
    const again = await alice.client.post<{ invitation: { invitation_id: string } }>("/sharing/invitation", { username: bob.masked.username });
    expect(again.body.invitation.invitation_id).toBe(first);
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE inviter_user_id = $1", [alice.user.user_id])).toHaveLength(1);
  });

  test("refuses the demo account, unknown and deleted users, oneself, current members and crossing invitations", async () => {
    const [alice, bob, carol, gone] = [await person("alice"), await person("bob"), await person("carol"), await person("gone")];
    await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE user_id = $1", [gone.user.user_id]);
    const demo = await stack.login("demo");
    await group(alice, bob);
    const crossingId = await invite(carol, alice);
    const cases: [ApiClient, string, string][] = [
      [alice.client, "demo", "The demo account can't share data."],
      [demo, alice.masked.username, "The demo account can't share data."],
      [alice.client, "nobody-by-that-name", "No user has that username."],
      [alice.client, "", "No user has that username."],
      [alice.client, gone.masked.username, "No user has that username."],
      [alice.client, alice.masked.username, "You can't invite yourself."],
      [alice.client, bob.masked.username, `You already share data with ${bob.masked.username}.`],
      [bob.client, alice.masked.username, `You already share data with ${alice.masked.username}.`],
      [alice.client, carol.masked.username, `${carol.masked.username} already invited you. Accept that invitation.`],
    ];
    for (const [client, username, message] of cases) {
      const result = await client.post("/sharing/invitation", { username });
      expect([username, result.status, result.json]).toEqual([username, 200, { status: "failed", message }]);
    }
    // The crossing invitation is untouched, and nothing new was stored.
    expect(await stack.db.query("SELECT invitation_id::text FROM sharing_invitations WHERE inviter_user_id = $1", [carol.user.user_id])).toEqual([
      { invitation_id: crossingId },
    ]);
  });

  test("lets a group member invite someone into the group", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    await group(alice, bob);
    const invitation_id = await invite(bob, carol);
    expect((await carol.client.post("/sharing/member", { invitation_id })).json).toEqual({ status: "success" });
    expect((await members(alice)).members).toEqual([alice.masked, bob.masked, carol.masked]);
  });
});

describe("DELETE /sharing/invitation", () => {
  test("refuses a missing, repeated, empty or malformed id", async () => {
    const alice = await person("alice");
    for (const [query, message] of [
      [undefined, "Missing required parameter: id"],
      [{ id: ["a", "b"] }, "Parameter id must be a single value, not an array"],
      [{ id: "" }, "Parameter id cannot be empty"],
      [{ id: " " }, "Parameter id cannot be empty"],
      [{ id: NOT_A_UUID }, "Field id must be a uuid"],
    ] as const) {
      const result = await alice.client.delete("/sharing/invitation", { query: query as Record<string, string> });
      expect(result.json).toEqual({ status: "failed", message });
    }
  });

  test("lets the invitee decline, the inviter withdraw, and the inviter's group withdraw", async () => {
    const [alice, bob, carol, dave] = [await person("alice"), await person("bob"), await person("carol"), await person("dave")];
    await group(alice, bob);
    const declined = await invite(alice, carol);
    const withdrawn = await invite(alice, dave);
    expect((await carol.client.delete("/sharing/invitation", { query: { id: declined } })).json).toEqual({ status: "success" });
    expect((await bob.client.delete("/sharing/invitation", { query: { id: withdrawn } })).json).toEqual({ status: "success" });
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE invitation_id = ANY($1::uuid[])", [[declined, withdrawn]])).toEqual([]);
    const third = await invite(carol, dave);
    expect((await carol.client.delete("/sharing/invitation", { query: { id: third } })).json).toEqual({ status: "success" });
  });

  test("answers a stranger, an answered invitation and a missing one alike, and leaves the row", async () => {
    const [alice, bob, eve] = [await person("alice"), await person("bob"), await person("eve")];
    const invitation_id = await invite(alice, bob);
    const notOpen = { status: "failed", message: "That invitation is no longer open." };
    expect((await eve.client.delete("/sharing/invitation", { query: { id: invitation_id } })).json).toEqual(notOpen);
    expect((await alice.client.delete("/sharing/invitation", { query: { id: MISSING_UUID } })).json).toEqual(notOpen);
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE invitation_id = $1", [invitation_id])).toHaveLength(1);
    expect((await bob.client.delete("/sharing/invitation", { query: { id: invitation_id } })).json).toEqual({ status: "success" });
    expect((await bob.client.delete("/sharing/invitation", { query: { id: invitation_id } })).json).toEqual(notOpen);
  });
});

describe("POST /sharing/member", () => {
  test("refuses a body without an invitation id string that is a UUID", async () => {
    const alice = await person("alice");
    for (const [body, message] of [
      [null, "Request body is required"],
      ["x", "Request body must be an object"],
      [{}, "Missing required field: invitation_id"],
      [{ invitation_id: null }, "Missing required field: invitation_id"],
      [{ invitation_id: 7 }, "Field invitation_id must be a string"],
      [{ invitation_id: "" }, "Field invitation_id must be a uuid"],
      [{ invitation_id: NOT_A_UUID }, "Field invitation_id must be a uuid"],
    ] as const) {
      expect((await alice.client.post("/sharing/member", body)).json).toEqual({ status: "failed", message });
    }
  });

  test("refuses the demo account before looking anything up", async () => {
    const demo = await stack.login("demo");
    expect((await demo.post("/sharing/member", { invitation_id: MISSING_UUID })).json).toEqual({
      status: "failed",
      message: "The demo account can't share data.",
    });
  });

  test("starts a group when neither person shares yet, and deletes the invitation", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    const invitation_id = await invite(alice, bob);
    const result = await bob.client.post("/sharing/member", { invitation_id });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success" });
    const rows = (await groupRows()).filter((row) => [alice.user.user_id, bob.user.user_id].includes(row.user_id));
    expect(rows).toHaveLength(2);
    expect(rows[0].group_id).toMatch(UUID);
    expect(rows[1].group_id).toBe(rows[0].group_id);
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE invitation_id = $1", [invitation_id])).toEqual([]);
    expect(await members(alice)).toEqual({ members: [alice.masked, bob.masked], invitations: [] });
  });

  test("joins the inviter's existing group, and clears every invitation between the members", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    await group(alice, bob);
    const byAlice = await invite(alice, carol);
    // Bob's invitation to Carol is answered by Alice's being accepted.
    const byBob = await bob.client.post<{ invitation: { invitation_id: string } }>("/sharing/invitation", { username: carol.masked.username });
    expect(byBob.json.status).toBe("success");
    expect((await carol.client.post("/sharing/member", { invitation_id: byAlice })).json).toEqual({ status: "success" });
    const ids = [alice.user.user_id, bob.user.user_id, carol.user.user_id];
    const rows = (await groupRows()).filter((row) => ids.includes(row.user_id));
    expect(new Set(rows.map((row) => row.group_id)).size).toBe(1);
    expect(rows).toHaveLength(3);
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE invitee_user_id = $1", [carol.user.user_id])).toEqual([]);
  });

  test("refuses an invitation that is not the caller's, is gone, or comes while the caller is in a group", async () => {
    const [alice, bob, carol, dave] = [await person("alice"), await person("bob"), await person("carol"), await person("dave")];
    const toBob = await invite(alice, bob);
    const notOpen = { status: "failed", message: "That invitation is no longer open." };
    expect((await alice.client.post("/sharing/member", { invitation_id: toBob })).json).toEqual(notOpen);
    expect((await carol.client.post("/sharing/member", { invitation_id: toBob })).json).toEqual(notOpen);
    expect((await bob.client.post("/sharing/member", { invitation_id: MISSING_UUID })).json).toEqual(notOpen);

    await group(carol, dave);
    const toDave = await invite(alice, dave);
    expect((await dave.client.post("/sharing/member", { invitation_id: toDave })).json).toEqual({
      status: "failed",
      message: "Stop sharing with your current group before joining another.",
    });
    // The refused invitation stays open.
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE invitation_id = $1", [toDave])).toHaveLength(1);
  });
});

describe("DELETE /sharing/member", () => {
  test("refuses a missing or malformed user id", async () => {
    const alice = await person("alice");
    for (const [query, message] of [
      [undefined, "Missing required parameter: user_id"],
      [{ user_id: "" }, "Parameter user_id cannot be empty"],
      [{ user_id: NOT_A_UUID }, "Field user_id must be a uuid"],
    ] as const) {
      expect((await alice.client.delete("/sharing/member", { query: query as Record<string, string> })).json).toEqual({
        status: "failed",
        message,
      });
    }
  });

  test("refuses when the caller shares with nobody, or not with that user", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    const refused = { status: "failed", message: "You don't share data with that user." };
    expect((await alice.client.delete("/sharing/member", { query: { user_id: bob.user.user_id } })).json).toEqual(refused);
    expect((await alice.client.delete("/sharing/member", { query: { user_id: alice.user.user_id } })).json).toEqual(refused);
    await group(alice, bob);
    expect((await alice.client.delete("/sharing/member", { query: { user_id: carol.user.user_id } })).json).toEqual(refused);
    expect((await carol.client.delete("/sharing/member", { query: { user_id: alice.user.user_id } })).json).toEqual(refused);
  });

  test("dissolves a group of two, whoever leaves", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await group(alice, bob);
    expect((await bob.client.delete("/sharing/member", { query: { user_id: bob.user.user_id } })).json).toEqual({ status: "success" });
    const ids = [alice.user.user_id, bob.user.user_id];
    expect((await groupRows()).filter((row) => ids.includes(row.user_id))).toEqual([]);
    expect(await members(alice)).toEqual({ members: [], invitations: [] });
  });

  test("takes one member out of a larger group and leaves the rest sharing", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    await group(alice, bob, carol);
    expect((await alice.client.delete("/sharing/member", { query: { user_id: carol.user.user_id } })).json).toEqual({ status: "success" });
    expect((await members(bob)).members).toEqual([alice.masked, bob.masked]);
    expect((await members(carol)).members).toEqual([]);
  });

  test("deletes the transfer pairs that span the split, and only those", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    await group(alice, bob, carol);
    const transaction = async (owner: Person, id: string) =>
      stack.db.insert("transactions", { transaction_id: id, user_id: owner.user.user_id, account_id: `${id}-account`, date: "2026-01-05", amount: 10 });
    const tag = `t${counter}`;
    for (const [owner, suffix] of [[alice, "a1"], [alice, "a2"], [bob, "b1"], [carol, "c1"]] as const) await transaction(owner, `${tag}-${suffix}`);
    const pair = async (owner: Person, a: string, b: string) =>
      (await stack.db.insert<{ pair_id: string }>("transaction_pairs", {
        pair_id: crypto.randomUUID(),
        user_id: owner.user.user_id,
        transaction_id_a: `${tag}-${a}`,
        transaction_id_b: `${tag}-${b}`,
        status: "confirmed",
      })).pair_id;
    const spanning = await pair(alice, "a1", "c1");
    const spanningOtherOwner = await pair(carol, "c1", "a2");
    const withinStayers = await pair(bob, "a1", "b1");
    const withinLeaver = await pair(alice, "a2", "a2");

    expect((await bob.client.delete("/sharing/member", { query: { user_id: carol.user.user_id } })).json).toEqual({ status: "success" });

    const state = await stack.db.query<{ pair_id: string; is_deleted: boolean }>(
      "SELECT pair_id::text, is_deleted FROM transaction_pairs WHERE pair_id = ANY($1::uuid[])",
      [[spanning, spanningOtherOwner, withinStayers, withinLeaver]],
    );
    const deleted = Object.fromEntries(state.map((row) => [row.pair_id, row.is_deleted]));
    expect(deleted).toEqual({ [spanning]: true, [spanningOtherOwner]: true, [withinStayers]: false, [withinLeaver]: false });
  });
});

describe("what a sharing group shares", () => {
  test("members read, change and delete each other's budgets; new rows take the parent's owner", async () => {
    const [alice, bob, eve] = [await person("alice"), await person("bob"), await person("eve")];
    await group(alice, bob);
    const budget = (await alice.client.get<{ budget: { budget_id: string } }>("/new-budget")).body.budget;

    const seenByBob = await bob.client.get<{ budgets: { budget_id: string }[] }>("/budgets");
    expect(seenByBob.body.budgets.map((b) => b.budget_id)).toContain(budget.budget_id);
    expect((await eve.client.get<{ budgets: unknown[] }>("/budgets")).body.budgets).toEqual([]);

    expect((await bob.client.post("/budget", { budget_id: budget.budget_id, name: "Renamed by Bob" })).json).toEqual({ status: "success" });
    const stored = await stack.db.one("SELECT name, user_id::text FROM budgets WHERE budget_id = $1", [budget.budget_id]);
    expect(stored).toEqual({ name: "Renamed by Bob", user_id: alice.user.user_id });

    // A section and category Bob creates under Alice's budget belong to Alice.
    const section = (await bob.client.get<{ section: { section_id: string } }>("/new-section", { query: { parent: budget.budget_id } })).body.section;
    const category = (await bob.client.get<{ category: { category_id: string } }>("/new-category", { query: { parent: section.section_id } })).body.category;
    expect(await stack.db.one("SELECT user_id::text FROM sections WHERE section_id = $1", [section.section_id])).toEqual({ user_id: alice.user.user_id });
    expect(await stack.db.one("SELECT user_id::text FROM categories WHERE category_id = $1", [category.category_id])).toEqual({ user_id: alice.user.user_id });

    // A stranger can do none of it.
    expect((await eve.client.get("/new-section", { query: { parent: budget.budget_id } })).json.status).toBe("failed");
    expect((await eve.client.post("/budget", { budget_id: budget.budget_id, name: "Eve" })).json).toEqual({ status: "success" });
    expect(await stack.db.one("SELECT name FROM budgets WHERE budget_id = $1", [budget.budget_id])).toEqual({ name: "Renamed by Bob" });

    expect((await bob.client.delete("/budget", { query: { id: budget.budget_id } })).json).toEqual({ status: "success" });
    const deleted = await stack.db.query<{ is_deleted: boolean }>(
      "SELECT is_deleted FROM budgets WHERE budget_id = $1 UNION ALL SELECT is_deleted FROM sections WHERE section_id = $2 UNION ALL SELECT is_deleted FROM categories WHERE category_id = $3",
      [budget.budget_id, section.section_id, category.category_id],
    );
    expect(deleted.map((row) => row.is_deleted)).toEqual([true, true, true]);
  });

  test("members read, change and delete each other's charts", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await group(alice, bob);
    const chart = (await alice.client.get<{ chart_id: string }>("/new-chart")).body;
    expect((await bob.client.get<{ chart_id: string }[]>("/charts")).body.map((c) => c.chart_id)).toContain(chart.chart_id);
    expect((await bob.client.post("/chart", { chart_id: chart.chart_id, name: "Bob's view" })).json).toEqual({ status: "success" });
    expect(await stack.db.one("SELECT name, user_id::text FROM charts WHERE chart_id = $1", [chart.chart_id])).toEqual({
      name: "Bob's view",
      user_id: alice.user.user_id,
    });
    expect((await bob.client.delete("/chart", { query: { id: chart.chart_id } })).json).toEqual({ status: "success" });
    expect(await stack.db.one("SELECT is_deleted FROM charts WHERE chart_id = $1", [chart.chart_id])).toEqual({ is_deleted: true });
  });

  test("stops at the moment someone leaves: each keeps their own rows and loses sight of the others'", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await group(alice, bob);
    const aliceBudget = (await alice.client.get<{ budget: { budget_id: string } }>("/new-budget")).body.budget.budget_id;
    const bobBudget = (await bob.client.get<{ budget: { budget_id: string } }>("/new-budget")).body.budget.budget_id;
    const ids = async (p: Person) => (await p.client.get<{ budgets: { budget_id: string }[] }>("/budgets")).body.budgets.map((b) => b.budget_id).sort();
    expect(await ids(alice)).toEqual([aliceBudget, bobBudget].sort());

    expect((await alice.client.delete("/sharing/member", { query: { user_id: bob.user.user_id } })).json).toEqual({ status: "success" });
    expect(await ids(alice)).toEqual([aliceBudget]);
    expect(await ids(bob)).toEqual([bobBudget]);
    expect((await bob.client.post("/budget", { budget_id: aliceBudget, name: "too late" })).json).toEqual({ status: "success" });
    expect(await stack.db.one("SELECT name FROM budgets WHERE budget_id = $1", [aliceBudget])).toEqual({ name: "New Budget" });
  });
});
