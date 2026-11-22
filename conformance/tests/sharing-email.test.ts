/**
 * Sharing by email address. `POST /sharing/invitation { email }` invites
 * whoever signs in with that address, now or before the invitation lapses
 * thirty days later, and answers alike whether anyone has the address yet.
 * `GET /sharing` lists it to the inviter's group by its address, and to the
 * user who has the address, while it is open, as addressed to them.
 * `DELETE /sharing/invitation` withdraws or declines it and
 * `POST /sharing/member` accepts it, as for an invitation to a username.
 *
 * Nothing happens at sign-in: the user with the address is looked up, in any
 * letter case, by each request, so an account that takes the address later,
 * through single sign-on or otherwise, finds the invitation waiting.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ApiClient, createUser, startStack, type ApiResult, type SeededUser, type Stack } from "../harness";
import { openEventStream, type EventStream } from "../harness/sse";
import { ssoSignIn } from "../harness/sso";

// Tests here wait on event streams and sign in through the fake identity provider: give each the
// suite's 30 seconds rather than the runner's default of five.
setDefaultTimeout(30_000);

let stack: Stack;
beforeAll(async () => {
  // Single sign-on on, for the account that signs up with an invited address; password sign-in
  // stays on for everyone else.
  stack = await startStack({ sso: { AUTH_LOCAL_LOGIN: "true" } });
});
afterAll(() => stack.stop());

const streams: EventStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
  stack.upstream.issuer.reset();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_OPEN = { status: "failed", message: "That invitation is no longer open." };
const NOT_AN_ADDRESS = "Field email must be an email address";
const TOO_LONG = "Field email must be at most 255 characters";
const AT_THE_CAP = "You have 20 invitations sent to email addresses. Withdraw one before sending another.";

type Masked = { user_id: string; username: string };
interface Invitation {
  invitation_id: string;
  inviter: Masked;
  invitee: Masked | { email: string };
  expires_at?: string;
}
interface Sharing {
  members: Masked[];
  invitations: Invitation[];
}

interface Person {
  user: SeededUser;
  client: ApiClient;
  masked: Masked;
}

let counter = 0;
const unique = (stem: string) => `${stem}-${++counter}`;
/** An address nobody has, unique in the run: the users' addresses are unique in any letter case. */
const address = (stem = "friend") => `${unique(stem)}@example.test`;

/** A fresh user, signed in with a password, with `email` if given. */
const person = async (name: string, email?: string): Promise<Person> => {
  const username = unique(name);
  const user = await createUser(stack, username, { email });
  const client = await stack.login(username, user.password);
  return { user, client, masked: { user_id: user.user_id, username } };
};

const clientOf = (who: Person | ApiClient): ApiClient => (who instanceof ApiClient ? who : who.client);

/** The headers of a request sent from the tab `tabId` names, if any. */
const tab = (tabId?: string): { headers: Record<string, string> } => ({ headers: tabId === undefined ? {} : { "X-Tab-Id": tabId } });

const inviteEmail = (from: Person | ApiClient, body: unknown, tabId?: string): Promise<ApiResult<{ invitation: Invitation }>> =>
  clientOf(from).post<{ invitation: Invitation }>("/sharing/invitation", body, tab(tabId));

/** `from` invites `email`, which must succeed; answers the invitation. */
const sendTo = async (from: Person, email: string, tabId?: string): Promise<Invitation> => {
  const result = await inviteEmail(from, { email }, tabId);
  expect(result.json.status).toBe("success");
  return result.body.invitation;
};

/** The invitation `from` sent to `email` now, as `POST /sharing/invitation` answers it, sent within [before, after]. */
const expectSent = (invitation: Invitation, from: Person, email: string, before: number, after: number) => {
  expect(invitation).toEqual({
    invitation_id: expect.stringMatching(UUID),
    inviter: from.masked,
    invitee: { email },
    expires_at: expect.stringMatching(ISO),
  });
  const lapses = Date.parse(invitation.expires_at as string);
  expect(lapses).toBeGreaterThanOrEqual(before + LIFETIME_MS);
  expect(lapses).toBeLessThanOrEqual(after + LIFETIME_MS);
};

/** The invitation as the user with the address reads it: addressed to them. */
const received = (invitation: Invitation, by: Person): Invitation => ({ ...invitation, invitee: by.masked });

const sharing = async (who: Person | ApiClient): Promise<Sharing> => (await clientOf(who).get<Sharing>("/sharing")).body;

/** The invitation to a username `from` sends `to`; answers its id. */
const inviteUser = async (from: Person, to: Person): Promise<string> => {
  const result = await from.client.post<{ invitation: { invitation_id: string } }>("/sharing/invitation", { username: to.masked.username });
  expect(result.json.status).toBe("success");
  return result.body.invitation.invitation_id;
};

const accept = async (member: Person | ApiClient, invitation_id: string, tabId?: string) =>
  (await clientOf(member).post("/sharing/member", { invitation_id }, tab(tabId))).json;

const decline = async (member: Person | ApiClient, id: string, tabId?: string) =>
  (await clientOf(member).delete("/sharing/invitation", { query: { id }, ...tab(tabId) })).json;

/** Puts `members` in one sharing group, through the routes: the first invites each of the others by username, and each accepts. */
const group = async (...members: Person[]): Promise<void> => {
  const [first, ...rest] = members;
  for (const member of rest) expect(await accept(member, await inviteUser(first, member))).toEqual({ status: "success" });
};

interface StoredInvitation {
  invitation_id: string;
  inviter_user_id: string;
  invitee_email: string;
  expires_at: string;
  updated: string | null;
}

/** The invitations to addresses `inviter` sent, as stored, by address. */
const stored = async (inviter: Person): Promise<StoredInvitation[]> =>
  stack.db.query<StoredInvitation & Record<string, unknown>>(
    `SELECT invitation_id::text, inviter_user_id::text, invitee_email,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
            to_char(updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated
     FROM sharing_email_invitations WHERE inviter_user_id = $1 ORDER BY invitee_email, invitation_id`,
    [inviter.user.user_id],
  );

const storedById = (invitation_id: string) =>
  stack.db.query("SELECT 1 FROM sharing_email_invitations WHERE invitation_id = $1", [invitation_id]);

/** Makes an invitation lapse a minute ago (to the millisecond, as the server writes it), and its last change a day ago. */
const lapse = (invitation_id: string) =>
  stack.db.query(
    `UPDATE sharing_email_invitations
     SET expires_at = date_trunc('milliseconds', now() - interval '1 minute'), updated = now() - interval '1 day'
     WHERE invitation_id = $1`,
    [invitation_id],
  );

const setEmail = (who: Person | string, email: string | null) =>
  stack.db.query("UPDATE users SET email = $2 WHERE user_id = $1", [typeof who === "string" ? who : who.user.user_id, email]);

const groupOf = async (who: Person): Promise<string | undefined> =>
  (await stack.db.one<{ group_id: string }>("SELECT group_id::text FROM sharing_members WHERE user_id = $1", [who.user.user_id]))?.group_id;

type Tab = { stream: EventStream; id: string };

/** Opens an event stream as `who` and reads up to its `connected` event; returns the stream and that event's id. */
const connect = async (who: Person): Promise<Tab> => {
  const stream = await openEventStream(who.client);
  streams.push(stream);
  expect(stream.status).toBe(200);
  const connected = await stream.next((block) => block.event === "connected");
  return { stream, id: connected.id as string };
};

const plus = (id: string, n: number) => String(Number(id) + n);

/** Expects the next event of every stream to be `event` with `data`, `n` ids past where that stream connected. */
const expectEach = async (tabs: Tab[], n: number, event: string, data: Record<string, string>) => {
  for (const tab of tabs) expect(await tab.stream.nextEvent()).toEqual({ id: plus(tab.id, n), event, data });
};

/** Expects the tab to have heard nothing more: its user's own write now is the `n`th thing it hears. */
const expectOwnWriteNext = async (who: Person, tab: Tab, n = 1) => {
  const tabId = `own-${who.masked.username}`;
  expect((await who.client.get("/new-budget", { headers: { "X-Tab-Id": tabId } })).json.status).toBe("success");
  expect(await tab.stream.nextEvent()).toEqual({ id: plus(tab.id, n), event: "budgets-updated", data: { originTabId: tabId } });
};

describe("POST /sharing/invitation { email }", () => {
  test("refuses an address that is null or not a string, an email key taking precedence over a username", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    for (const [body, message] of [
      [{ email: null }, "Missing required field: email"],
      [{ email: null, username: bob.masked.username }, "Missing required field: email"],
      [{ email: 42 }, "Field email must be a string"],
      [{ email: true }, "Field email must be a string"],
      [{ email: ["friend@example.test"] }, "Field email must be a string"],
      [{ email: { address: "friend@example.test" } }, "Field email must be a string"],
      [{ email: "not an address", username: bob.masked.username }, NOT_AN_ADDRESS],
    ] as const) {
      const result = await inviteEmail(alice, body);
      expect([body, result.status, result.json]).toEqual([body, 200, { status: "failed", message }]);
    }
    expect(await stored(alice)).toEqual([]);
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE inviter_user_id = $1", [alice.user.user_id])).toEqual([]);
  });

  test("refuses text that is not one @ with something on each side and no white space in it", async () => {
    const alice = await person("alice");
    for (const email of [
      "",
      "   ",
      "@",
      "friend.example.test",
      "@example.test",
      "friend@",
      "  friend@  ",
      "a@b@example.test",
      "a friend@example.test",
      "friend@exam ple.test",
      "a\tb@example.test",
      "a\nb@example.test",
      // White space as JavaScript's `\s` has it: the no-break space, a line separator, the BOM, the ideographic space.
      "a\u00a0b@example.test",
      "a\u2028b@example.test",
      "a\ufeffb@example.test",
      "a\u3000b@example.test",
    ]) {
      const result = await inviteEmail(alice, { email });
      expect([email, result.json]).toEqual([email, { status: "failed", message: NOT_AN_ADDRESS }]);
    }
    expect(await stored(alice)).toEqual([]);
  });

  test("takes an address with characters JavaScript does not count as white space, and trims the ones it does", async () => {
    const alice = await person("alice");
    // U+0085 (next line) is no white space to JavaScript; the BOM and the no-break space around an address are trimmed.
    const nextLine = `${unique("a\u0085b")}@example.test`;
    expect((await sendTo(alice, nextLine)).invitee).toEqual({ email: nextLine });
    const trimmed = address("trimmed");
    expect((await sendTo(alice, `\ufeff\u00a0 ${trimmed}\n\u2029`)).invitee).toEqual({ email: trimmed });
    expect((await stored(alice)).map((row) => row.invitee_email).sort()).toEqual([nextLine, trimmed].sort());
  });

  test("measures an address as it is stored, trimmed and in lower case, in UTF-16 units, up to 255 of them", async () => {
    const alice = await person("alice");
    const tag = unique("x");
    const longest = `${"a".repeat(255 - `@${tag}.test`.length)}@${tag}.test`;
    expect(longest).toHaveLength(255);
    // An emoji is two units, though one character to the database: as many as fit, and one more.
    const suffix = `@${tag}.t`;
    const fitting = Math.floor((255 - suffix.length) / 2);
    const emoji = `${"😀".repeat(fitting)}${suffix}`;
    const emojiTooMany = `${"😀".repeat(fitting + 1)}${suffix}`;
    expect([emoji.length <= 255, emojiTooMany.length > 255, [...emojiTooMany].length < 255]).toEqual([true, true, true]);
    for (const [email, message] of [
      [`${longest}b`, TOO_LONG],
      // Measured before it is read as an address: the length is named, not the missing @.
      ["a".repeat(300), TOO_LONG],
      // Lower case can be longer: "İ" becomes "i\u0307", two units.
      [`${"İ".repeat(245)}@x.io`, TOO_LONG],
      [emojiTooMany, TOO_LONG],
    ]) {
      const result = await inviteEmail(alice, { email });
      expect([email.length, result.json]).toEqual([email.length, { status: "failed", message }]);
    }
    expect(await stored(alice)).toEqual([]);

    // The longest, with white space around it that the trim takes off.
    expect((await sendTo(alice, `  ${longest.toUpperCase()}\t`)).invitee).toEqual({ email: longest });
    expect((await sendTo(alice, emoji)).invitee).toEqual({ email: emoji });
    expect((await stored(alice)).map((row) => row.invitee_email).sort()).toEqual([longest, emoji].sort());
  });

  test("invites an address nobody has, trimmed and in lower case, open for thirty days", async () => {
    const alice = await person("alice");
    const email = address("nobody");
    const before = Date.now();
    const result = await inviteEmail(alice, { email: `  ${email.toUpperCase()} ` });
    const after = Date.now();
    expect(result.status).toBe(200);
    expect(result.json.status).toBe("success");
    const { invitation } = result.body;
    expectSent(invitation, alice, email, before, after);
    expect(await stored(alice)).toEqual([
      {
        invitation_id: invitation.invitation_id,
        inviter_user_id: alice.user.user_id,
        invitee_email: email,
        expires_at: invitation.expires_at as string,
        updated: expect.any(String),
      },
    ]);
    expect(await sharing(alice)).toEqual({ members: [], invitations: [invitation] });
  });

  test("lowers the case of letters beyond ASCII as JavaScript does", async () => {
    const alice = await person("alice");
    const tag = unique("t");
    for (const [sent, kept] of [
      [`ÉLODIE.${tag}@EXAMPLE.TEST`, `élodie.${tag}@example.test`],
      // A final sigma before the @, a medial one before a full stop and another letter.
      [`ΟΔΟΣ.ΟΔΟΣ.${tag}@X.TEST`, `οδοσ.οδοσ.${tag}@x.test`],
      [`ΟΔΟΣ@${tag}.TEST`, `οδος@${tag}.test`],
      [`İ${tag}@X.TEST`, `i\u0307${tag}@x.test`],
    ]) {
      expect([sent, (await sendTo(alice, sent)).invitee]).toEqual([sent, { email: kept }]);
    }
  });

  test("answers an address someone has exactly as one nobody has, and names nobody", async () => {
    const [alice, bob] = [await person("alice"), await person("bob", `Bob.${unique("b")}@Example.TEST`)];
    const bobs = (await stack.db.one<{ email: string }>("SELECT email FROM users WHERE user_id = $1", [bob.user.user_id]))!.email;
    const before = Date.now();
    const result = await inviteEmail(alice, { email: bobs.toLowerCase() });
    const after = Date.now();
    expectSent(result.body.invitation, alice, bobs.toLowerCase(), before, after);
    expect(result.text).not.toContain(bob.user.user_id);
    expect(result.text).not.toContain(bob.masked.username);
    // Bob reads it as sent to him.
    expect(await sharing(bob)).toEqual({ members: [], invitations: [received(result.body.invitation, bob)] });
  });

  test("refuses the caller's own address in any letter case, and the address of someone already sharing with them", async () => {
    const tag = unique("own");
    const [alice, bob] = [await person("alice", `Alice.${tag}@Example.TEST`), await person("bob", `bob.${tag}@example.test`)];
    await group(alice, bob);
    for (const [from, email, message] of [
      [alice, `ALICE.${tag}@example.test`, "You can't invite yourself."],
      [alice, `alice.${tag}@example.test`, "You can't invite yourself."],
      [alice, `Bob.${tag}@Example.Test`, `You already share data with ${bob.masked.username}.`],
      [bob, `alice.${tag}@example.test`, `You already share data with ${alice.masked.username}.`],
    ] as const) {
      const result = await inviteEmail(from, { email });
      expect([email, result.status, result.json]).toEqual([email, 200, { status: "failed", message }]);
    }
    expect(await stored(alice)).toEqual([]);
    expect(await stored(bob)).toEqual([]);
  });

  test("invites the address of a deleted account as one nobody has", async () => {
    const [alice, gone] = [await person("alice"), await person("gone", address("gone"))];
    const email = (await stack.db.one<{ email: string }>("SELECT email FROM users WHERE user_id = $1", [gone.user.user_id]))!.email;
    await stack.db.query("UPDATE users SET is_deleted = TRUE WHERE user_id = $1", [gone.user.user_id]);
    expect((await sendTo(alice, email)).invitee).toEqual({ email });
  });

  test("refuses the demo account, after the address is read", async () => {
    const demo = await stack.login("demo");
    expect((await inviteEmail(demo, { email: "not an address" })).json).toEqual({ status: "failed", message: NOT_AN_ADDRESS });
    expect((await inviteEmail(demo, { email: address() })).json).toEqual({ status: "failed", message: "The demo account can't share data." });
    expect(await stack.db.query("SELECT 1 FROM sharing_email_invitations e JOIN users u ON u.user_id = e.inviter_user_id WHERE u.username = 'demo'")).toEqual([]);
  });

  // Pinned: an invitation to a username refuses the demo account as its invitee, but one to an
  // address the demo account has is sent, and the demo account sees it, can decline it, and only
  // accepting it is refused.
  test("sends an invitation to an address the demo account has, which it can see and decline but not accept", async () => {
    const alice = await person("alice");
    const demoId = await stack.userId("demo");
    const email = address("demo");
    await setEmail(demoId, email);
    try {
      const invitation = await sendTo(alice, email);
      const demo = await stack.login("demo");
      expect(await sharing(demo)).toEqual({ members: [], invitations: [{ ...invitation, invitee: { user_id: demoId, username: "demo" } }] });
      expect(await accept(demo, invitation.invitation_id)).toEqual({
        status: "failed",
        message: "The demo account can't share data.",
      });
      expect(await decline(demo, invitation.invitation_id)).toEqual({ status: "success" });
      expect(await storedById(invitation.invitation_id)).toEqual([]);
    } finally {
      await setEmail(demoId, null);
    }
  });

  test("sends an address again by keeping the invitation and restarting its thirty days, in any letter case", async () => {
    const alice = await person("alice");
    const email = address("again");
    const first = await sendTo(alice, email);
    await lapse(first.invitation_id);
    const [lapsed] = await stored(alice);
    const before = Date.now();
    const again = (await inviteEmail(alice, { email: email.toUpperCase() })).body.invitation;
    const after = Date.now();
    expectSent(again, alice, email, before, after);
    expect(again.invitation_id).toBe(first.invitation_id);
    const [renewed] = await stored(alice);
    expect(renewed).toEqual({ ...lapsed, expires_at: again.expires_at as string, updated: expect.any(String) });
    expect(renewed.updated! > lapsed.updated!).toBe(true);
  });

  test("lets each member of a group keep an invitation of their own to one address", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await group(alice, bob);
    const email = address("both");
    const [byAlice, byBob] = [await sendTo(alice, email), await sendTo(bob, email)];
    expect(byBob.invitation_id).not.toBe(byAlice.invitation_id);
    // Both the group's, by address, then by id.
    const expected = [byAlice, byBob].sort((a, b) => (a.invitation_id < b.invitation_id ? -1 : 1));
    expect((await sharing(alice)).invitations).toEqual(expected);
    expect((await sharing(bob)).invitations).toEqual(expected);
  });

  // Unlike an invitation to a username, one to an address does not look for a crossing invitation:
  // refusing it would tell the sender who has the address.
  test("sends an invitation to the address of someone who already invited the caller by username", async () => {
    const [alice, bob] = [await person("alice"), await person("bob", address("crossing"))];
    const byBob = await inviteUser(bob, alice);
    const bobs = (await stack.db.one<{ email: string }>("SELECT email FROM users WHERE user_id = $1", [bob.user.user_id]))!.email;
    const byAlice = await sendTo(alice, bobs);
    expect(await sharing(bob)).toEqual({
      members: [],
      invitations: [{ invitation_id: byBob, inviter: bob.masked, invitee: alice.masked }, received(byAlice, bob)],
    });
    // Accepting Bob's settles Alice's too, since the two now share.
    expect(await accept(alice, byBob)).toEqual({ status: "success" });
    expect(await storedById(byAlice.invitation_id)).toEqual([]);
    expect(await sharing(bob)).toEqual({ members: [alice.masked, bob.masked].sort((a, b) => (a.username < b.username ? -1 : 1)), invitations: [] });
  });

  test("keeps at most twenty invitations to addresses per sender, lapsed ones counted, other senders apart", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await group(alice, bob);
    const tag = unique("cap");
    const addresses = Array.from({ length: 21 }, (_, i) => `to${String(i).padStart(2, "0")}.${tag}@example.test`);
    const sent: Invitation[] = [];
    for (const email of addresses.slice(0, 19)) sent.push(await sendTo(alice, email));
    await lapse(sent[0].invitation_id);
    // Nineteen sent, one of them lapsed: the twentieth still goes, and then the lapsed one counts.
    sent.push(await sendTo(alice, addresses[19]));
    const [ta, tb] = [await connect(alice), await connect(bob)];
    const refused = await inviteEmail(alice, { email: addresses[20] }, "capped-tab");
    expect([refused.status, refused.json]).toEqual([200, { status: "failed", message: AT_THE_CAP }]);
    expect(await stored(alice)).toHaveLength(20);
    // Refused, it tells nobody: the first thing either tab hears is alice's own write.
    await expectOwnWriteNext(alice, ta);
    expect(await tb.stream.nextEvent()).toEqual({ id: plus(tb.id, 1), event: "budgets-updated", data: { originTabId: `own-${alice.masked.username}` } });
    // Sending to an address already invited adds no row, so it goes at the cap; the lapsed one reopens.
    const renewed = await sendTo(alice, addresses[0]);
    expect(renewed.invitation_id).toBe(sent[0].invitation_id);
    expect(Date.parse(renewed.expires_at as string)).toBeGreaterThan(Date.now());
    // The cap is the sender's own: another member of the group still sends.
    expect((await sendTo(bob, addresses[20])).invitee).toEqual({ email: addresses[20] });
    // Withdrawing one makes room.
    expect(await decline(alice, sent[5].invitation_id)).toEqual({ status: "success" });
    expect((await sendTo(alice, addresses[20])).invitee).toEqual({ email: addresses[20] });
    expect(await stored(alice)).toHaveLength(20);
    expect((await inviteEmail(alice, { email: addresses[5] })).json).toEqual({ status: "failed", message: AT_THE_CAP });
  });
});

describe("GET /sharing with invitations to addresses", () => {
  test("shows one by address to the inviter's group, as addressed to the user with the address, and to nobody else", async () => {
    const tag = unique("seen");
    const [alice, bob, carol, dave, eve] = [
      await person("alice"),
      await person("bob"),
      await person("carol", `Carol.${tag}@Example.TEST`),
      await person("dave"),
      await person("eve"),
    ];
    await group(alice, bob);
    await group(carol, dave);
    const invitation = await sendTo(alice, `CAROL.${tag}@EXAMPLE.TEST`);
    expect(invitation.invitee).toEqual({ email: `carol.${tag}@example.test` });
    const byName = (a: Masked, b: Masked) => (a.username < b.username ? -1 : 1);
    expect(await sharing(alice)).toEqual({ members: [alice.masked, bob.masked].sort(byName), invitations: [invitation] });
    expect(await sharing(bob)).toEqual({ members: [alice.masked, bob.masked].sort(byName), invitations: [invitation] });
    expect(await sharing(carol)).toEqual({ members: [carol.masked, dave.masked].sort(byName), invitations: [received(invitation, carol)] });
    // Not carol's group: the invitation went to her address alone.
    expect(await sharing(dave)).toEqual({ members: [carol.masked, dave.masked].sort(byName), invitations: [] });
    expect(await sharing(eve)).toEqual({ members: [], invitations: [] });
  });

  test("lists invitations to usernames first, by username, then invitations to addresses, by address", async () => {
    const tag = unique("order");
    const alice = await person("alice");
    const [mike, zack] = [await person(`m${tag}`), await person(`z${tag}`)];
    const toZack = await inviteUser(alice, zack);
    const toB = await sendTo(alice, `b.${tag}@example.test`);
    const toMike = await inviteUser(alice, mike);
    const toA = await sendTo(alice, `a.${tag}@example.test`);
    const { invitations } = await sharing(alice);
    expect(invitations.map((invitation) => invitation.invitation_id)).toEqual([toMike, toZack, toA.invitation_id, toB.invitation_id]);
    expect(invitations.slice(0, 2)).toEqual([
      { invitation_id: toMike, inviter: alice.masked, invitee: mike.masked },
      { invitation_id: toZack, inviter: alice.masked, invitee: zack.masked },
    ]);
  });

  test("keeps a lapsed invitation with the group that sent it, and takes it from the user with the address", async () => {
    const email = address("lapsed");
    const [alice, carol] = [await person("alice"), await person("carol", email)];
    const invitation = await sendTo(alice, email);
    expect((await sharing(carol)).invitations).toEqual([received(invitation, carol)]);
    await lapse(invitation.invitation_id);
    const [row] = await stored(alice);
    expect(await sharing(alice)).toEqual({ members: [], invitations: [{ ...invitation, expires_at: row.expires_at }] });
    expect(Date.parse(row.expires_at)).toBeLessThan(Date.now());
    expect(await sharing(carol)).toEqual({ members: [], invitations: [] });
  });

  test("reaches whoever has the address when they read: an account made later, or one whose address changes", async () => {
    const tag = unique("later");
    const alice = await person("alice");
    const invitation = await sendTo(alice, `later.${tag}@example.test`);
    const newcomer = await person("newcomer", `Later.${tag}@EXAMPLE.test`);
    expect(await sharing(newcomer)).toEqual({ members: [], invitations: [received(invitation, newcomer)] });

    // The address moves to another account, and the invitation with it.
    await setEmail(newcomer, `elsewhere.${tag}@example.test`);
    expect(await sharing(newcomer)).toEqual({ members: [], invitations: [] });
    const other = await person("other");
    await setEmail(other, `LATER.${tag}@example.test`);
    expect(await sharing(other)).toEqual({ members: [], invitations: [received(invitation, other)] });
  });

  test("reaches an account that signs up through single sign-on with the address, which can accept it", async () => {
    const tag = unique("sso");
    const alice = await person("alice");
    const invitation = await sendTo(alice, `sso.${tag}@example.test`);

    const client = stack.anonymous();
    const claims = { sub: `usr_${tag}`, username: `sso-${tag}`, sid: `ses_${tag}` };
    await ssoSignIn(stack, client, { claims, idClaims: { email: `SSO.${tag}@Example.Test` } });
    const row = await stack.db.one<{ user_id: string; email: string }>("SELECT user_id::text, email FROM users WHERE auth_sub = $1", [claims.sub]);
    expect(row?.email).toBe(`SSO.${tag}@Example.Test`);
    const newcomer = { user_id: row!.user_id, username: claims.username };

    expect(await sharing(client)).toEqual({ members: [], invitations: [{ ...invitation, invitee: newcomer }] });
    expect(await accept(client, invitation.invitation_id)).toEqual({ status: "success" });
    expect(await sharing(client)).toEqual({ members: [alice.masked, newcomer].sort((a, b) => (a.username < b.username ? -1 : 1)), invitations: [] });
    expect(await storedById(invitation.invitation_id)).toEqual([]);
  });
});

describe("DELETE /sharing/invitation for an invitation to an address", () => {
  test("lets the inviter, or anyone in the inviter's group, withdraw it, lapsed or not", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await group(alice, bob);
    const [open, lapsed] = [await sendTo(alice, address("open")), await sendTo(alice, address("lapsed"))];
    await lapse(lapsed.invitation_id);
    const result = await bob.client.delete("/sharing/invitation", { query: { id: open.invitation_id } });
    expect([result.status, result.json]).toEqual([200, { status: "success" }]);
    expect(await decline(alice, lapsed.invitation_id)).toEqual({ status: "success" });
    expect(await stored(alice)).toEqual([]);
    expect(await decline(alice, open.invitation_id)).toEqual(NOT_OPEN);
  });

  test("lets the user with the address decline it while it is open, and not once it has lapsed", async () => {
    const email = address("decline");
    const [alice, carol] = [await person("alice"), await person("carol", email.toUpperCase())];
    const invitation = await sendTo(alice, email);
    await lapse(invitation.invitation_id);
    expect(await decline(carol, invitation.invitation_id)).toEqual(NOT_OPEN);
    expect(await storedById(invitation.invitation_id)).toHaveLength(1);
    // Sent again, it is open again.
    await sendTo(alice, email);
    expect(await decline(carol, invitation.invitation_id)).toEqual({ status: "success" });
    expect(await storedById(invitation.invitation_id)).toEqual([]);
  });

  test("answers a stranger, the group of the user with the address, and a missing id alike, and leaves the row", async () => {
    const email = address("strangers");
    const [alice, carol, dave, eve] = [await person("alice"), await person("carol", email), await person("dave"), await person("eve")];
    await group(carol, dave);
    const invitation = await sendTo(alice, email);
    expect(await decline(eve, invitation.invitation_id)).toEqual(NOT_OPEN);
    expect(await decline(dave, invitation.invitation_id)).toEqual(NOT_OPEN);
    expect(await decline(alice, MISSING_UUID)).toEqual(NOT_OPEN);
    expect(await storedById(invitation.invitation_id)).toHaveLength(1);
  });
});

describe("POST /sharing/member for an invitation to an address", () => {
  test("lets the user with the address accept it: a group starts, and the invitation goes", async () => {
    const email = address("accept");
    const [alice, carol] = [await person("alice"), await person("carol", email.toUpperCase())];
    const invitation = await sendTo(alice, email);
    const result = await carol.client.post("/sharing/member", { invitation_id: invitation.invitation_id });
    expect([result.status, result.json]).toEqual([200, { status: "success" }]);
    const group_id = await groupOf(alice);
    expect(group_id).toMatch(UUID);
    expect(await groupOf(carol)).toBe(group_id);
    expect(await storedById(invitation.invitation_id)).toEqual([]);
    const members = [alice.masked, carol.masked].sort((a, b) => (a.username < b.username ? -1 : 1));
    expect(await sharing(alice)).toEqual({ members, invitations: [] });
    expect(await sharing(carol)).toEqual({ members, invitations: [] });
  });

  test("joining clears every invitation from the group to the one joining, and leaves others' alone", async () => {
    const email = address("joining");
    const [alice, bob, carol, dave] = [await person("alice"), await person("bob"), await person("carol", email), await person("dave")];
    await group(alice, bob);
    const [byAlice, byBob, byDave] = [await sendTo(alice, email), await sendTo(bob, email), await sendTo(dave, email)];
    const byBobToName = await inviteUser(bob, carol);
    expect(await accept(carol, byAlice.invitation_id)).toEqual({ status: "success" });
    expect(await storedById(byAlice.invitation_id)).toEqual([]);
    expect(await storedById(byBob.invitation_id)).toEqual([]);
    expect(await stack.db.query("SELECT 1 FROM sharing_invitations WHERE invitation_id = $1", [byBobToName])).toEqual([]);
    // Dave's is still open to carol, who has to leave the group to take it.
    expect((await sharing(carol)).invitations).toEqual([received(byDave, carol)]);
    expect(await accept(carol, byDave.invitation_id)).toEqual({
      status: "failed",
      message: "Stop sharing with your current group before joining another.",
    });
    expect(await storedById(byDave.invitation_id)).toHaveLength(1);
  });

  test("refuses one that has lapsed, one to someone else's address, and one the caller sent, even to their own address", async () => {
    const email = address("refused");
    const [alice, carol, eve] = [await person("alice"), await person("carol", email), await person("eve")];
    const invitation = await sendTo(alice, email);
    expect(await accept(eve, invitation.invitation_id)).toEqual(NOT_OPEN);
    expect(await accept(alice, invitation.invitation_id)).toEqual(NOT_OPEN);
    expect(await accept(carol, MISSING_UUID)).toEqual(NOT_OPEN);

    await lapse(invitation.invitation_id);
    expect(await accept(carol, invitation.invitation_id)).toEqual(NOT_OPEN);

    // Sent again and open, but the address is now the inviter's own.
    await sendTo(alice, email);
    await setEmail(carol, null);
    await setEmail(alice, email);
    expect(await accept(alice, invitation.invitation_id)).toEqual(NOT_OPEN);
    expect(await sharing(alice)).toEqual({ members: [], invitations: [{ ...invitation, expires_at: expect.stringMatching(ISO) }] });
    expect(await storedById(invitation.invitation_id)).toHaveLength(1);
    expect(await groupOf(alice)).toBeUndefined();
  });
});

describe("what an invitation to an address tells open tabs", () => {
  test("sending to an address nobody has reaches the inviter's group alone", async () => {
    const [alice, bob, outsider] = [await person("alice"), await person("bob"), await person("outsider")];
    await group(alice, bob);
    const [ta, tb, tOutsider] = [await connect(alice), await connect(bob), await connect(outsider)];
    await sendTo(alice, address("nobody"), "inviting-tab");
    await expectEach([ta, tb], 1, "sharing_invitations-updated", { originTabId: "inviting-tab" });
    await expectOwnWriteNext(outsider, tOutsider);
  });

  test("sending to an address someone has reaches that user too, but not their group", async () => {
    const email = address("someone");
    const [alice, bob, carol, dave] = [await person("alice"), await person("bob"), await person("carol", email), await person("dave")];
    await group(alice, bob);
    await group(carol, dave);
    const [ta, tb, tc, td] = [await connect(alice), await connect(bob), await connect(carol), await connect(dave)];
    await sendTo(alice, email, "inviting-tab");
    await expectEach([ta, tb, tc], 1, "sharing_invitations-updated", { originTabId: "inviting-tab" });
    await expectOwnWriteNext(dave, td);
    // Which carol hears as her partner's.
    expect(await tc.stream.nextEvent()).toEqual({ id: plus(tc.id, 2), event: "budgets-updated", data: { originTabId: `own-${dave.masked.username}` } });
  });

  test("a refused invitation sends nothing", async () => {
    const tag = unique("quiet");
    const [alice, bob] = [await person("alice", `alice.${tag}@example.test`), await person("bob", `bob.${tag}@example.test`)];
    await group(alice, bob);
    const [ta, tb] = [await connect(alice), await connect(bob)];
    for (const email of [`alice.${tag}@example.test`, `bob.${tag}@example.test`, "no address", null]) {
      expect((await inviteEmail(alice, { email }, "refused")).json.status).toBe("failed");
    }
    await expectOwnWriteNext(alice, ta);
    expect(await tb.stream.nextEvent()).toEqual({ id: plus(tb.id, 1), event: "budgets-updated", data: { originTabId: `own-${alice.masked.username}` } });
  });

  test("withdrawing reaches the inviter's group, and the group of the user with the address when anyone has it", async () => {
    const email = address("withdrawn");
    const [alice, bob, carol, dave, outsider] = [
      await person("alice"),
      await person("bob"),
      await person("carol", email),
      await person("dave"),
      await person("outsider"),
    ];
    await group(alice, bob);
    await group(carol, dave);
    const [toCarol, toNobody] = [await sendTo(alice, email), await sendTo(alice, address("nobody"))];
    const [ta, tb, tc, td, tOutsider] = [await connect(alice), await connect(bob), await connect(carol), await connect(dave), await connect(outsider)];

    expect(await decline(bob, toCarol.invitation_id, "withdrawing-tab")).toEqual({ status: "success" });
    await expectEach([ta, tb, tc, td], 1, "sharing_invitations-updated", { originTabId: "withdrawing-tab" });
    expect(await decline(alice, toNobody.invitation_id)).toEqual({ status: "success" });
    await expectEach([ta, tb], 2, "sharing_invitations-updated", {});
    await expectOwnWriteNext(dave, td, 2);
    await expectOwnWriteNext(outsider, tOutsider);
  });

  test("declining reaches both people's groups", async () => {
    const email = address("declined");
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol", email)];
    await group(alice, bob);
    const invitation = await sendTo(alice, email);
    const [ta, tb, tc] = [await connect(alice), await connect(bob), await connect(carol)];
    expect(await decline(carol, invitation.invitation_id, "declining-tab")).toEqual({ status: "success" });
    await expectEach([ta, tb, tc], 1, "sharing_invitations-updated", { originTabId: "declining-tab" });
  });

  test("accepting reaches every member of the group it grows, the one joining included", async () => {
    const email = address("joined");
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol", email)];
    await group(alice, bob);
    const invitation = await sendTo(alice, email);
    const [ta, tb, tc] = [await connect(alice), await connect(bob), await connect(carol)];
    expect(await accept(carol, invitation.invitation_id, "joining-tab")).toEqual({ status: "success" });
    await expectEach([ta, tb, tc], 1, "sharing_members-updated", { originTabId: "joining-tab" });
  });
});
