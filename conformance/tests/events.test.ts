/**
 * `GET /events`: the server-sent event stream each open tab holds. A write by
 * any of a user's tabs reaches all of them as `<table>-updated`; a tab that
 * reconnects says the last id it saw and is sent what it missed, or told to
 * fetch everything again when that cannot be worked out.
 *
 * The writes here are `GET /new-budget` (table `budgets`) and, through an API
 * key, `POST /suggest-category` (table `transactions`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { openEventStream, type EventStream, type EventStreamOptions } from "../harness/sse";

// Tests here start, restart and wait on real server processes: give each the suite's 30 seconds
// rather than the runner's default of five.
setDefaultTimeout(30_000);

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const streams: EventStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
});

const open = async (client: ApiClient, options: EventStreamOptions = {}): Promise<EventStream> => {
  const stream = await openEventStream(client, options);
  streams.push(stream);
  return stream;
};

/** Opens a stream and reads up to its `connected` event; returns the stream and that event's id. */
const connect = async (client: ApiClient, options: EventStreamOptions = {}): Promise<{ stream: EventStream; id: string }> => {
  const stream = await open(client, options);
  expect(stream.status).toBe(200);
  const connected = await stream.next((block) => block.event === "connected");
  return { stream, id: connected.id as string };
};

/** The whole of a stream that carries nothing but its opening: the primer and `connected`. */
const opening = (id: string) => `: connected\n\nid: ${id}\nevent: connected\ndata: {}\n\n`;
const RETRY_FULL = "event: retry-full\ndata: {}\n\n";

let users = 0;
const newUser = () => createUserClient(stack, `events-user-${++users}`);

/** A write to the `budgets` table by `client`'s user. */
const write = async (client: ApiClient, tabId?: string): Promise<void> => {
  const result = await client.get("/new-budget", { headers: tabId === undefined ? {} : { "X-Tab-Id": tabId } });
  expect(result.json.status).toBe("success");
};

const plus = (id: string, n: number) => String(Number(id) + n);

describe("opening the stream", () => {
  test("refuses an anonymous caller", async () => {
    const stream = await open(stack.anonymous());
    expect(stream.status).toBe(401);
    expect(await stream.json()).toEqual({ status: "failed", message: "Not authenticated." });
    expect(stream.headers.get("content-type")).toBe("application/json");
  });

  test("answers with an event stream no proxy should buffer or cache, and leaves the session cookie alone", async () => {
    const { client } = await newUser();
    const stream = await open(client);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    expect(stream.headers.get("x-content-type-options")).toBe("nosniff");
    expect(stream.headers.get("x-frame-options")).toBe("DENY");
    expect(stream.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(stream.headers.get("content-security-policy")).toStartWith("default-src 'self'");
    expect(stream.headers.get("strict-transport-security")).toBeNull();
    expect(stream.headers.getSetCookie()).toEqual([]);
  });

  test("starts with a comment to open the connection, then `connected` with the current event id", async () => {
    const { client } = await newUser();
    const before = Date.now();
    const stream = await open(client);
    const primer = await stream.next();
    expect(primer).toEqual({ comment: "connected", raw: ": connected" });
    const connected = await stream.next();
    expect(connected).toEqual({ id: expect.stringMatching(/^\d{13}$/), event: "connected", data: {}, raw: expect.any(String) });
    expect(stream.text).toBe(opening(connected.id as string));
    // Before anything was written, the id is where the server's ids start: the moment it booted.
    expect(Number(connected.id)).toBeLessThanOrEqual(before);
    expect(Number(connected.id)).toBeGreaterThan(before - 3_600_000);
    // And the stream stays open.
    expect(stream.ended).toBe(false);
  });

  test("gives every tab of a user, and every user who has seen no write, the same starting id", async () => {
    const one = await newUser();
    const other = await newUser();
    const first = await connect(one.client);
    const second = await connect(one.client);
    const third = await connect(await stack.login(one.user.username, one.user.password));
    const theirs = await connect(other.client);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(theirs.id).toBe(first.id);
  });

  test("is logged with how many streams the user now has, and again when the tab goes away", async () => {
    const { user, client } = await newUser();
    const first = await connect(client);
    await connect(client);
    const subscribed = (total: number) =>
      stack.logs.some((line) => line.includes("SSE subscribed") && line.includes(user.user_id) && line.includes(`"total":${total}`));
    await stack.waitFor(() => subscribed(1) && subscribed(2), { what: "the subscription log lines" });
    expect(stack.logs.find((line) => line.includes("SSE subscribed") && line.includes(user.user_id))).toContain('"replayed":0,"retryFull":false');

    await first.stream.close();
    const unsubscribed = (remaining: number) =>
      stack.logs.some((line) => line.includes("SSE unsubscribed") && line.includes(user.user_id) && line.includes(`"remaining":${remaining}`));
    await stack.waitFor(() => unsubscribed(1), { what: "the first tab's disconnect to be noticed" });
    for (const stream of streams.splice(0)) await stream.close();
    await stack.waitFor(() => unsubscribed(0), { what: "the second tab's disconnect to be noticed" });
  });
});

describe("a write", () => {
  test("reaches every open tab of the user as `<table>-updated`, with the next id", async () => {
    const { user, client } = await newUser();
    const sameSession = await connect(client);
    const otherSession = await connect(await stack.login(user.username, user.password));
    await write(client);
    const expected = { id: plus(sameSession.id, 1), event: "budgets-updated", data: {} };
    expect(await sameSession.stream.nextEvent()).toEqual(expected);
    expect(await otherSession.stream.nextEvent()).toEqual(expected);
    expect(sameSession.stream.text).toBe(`${opening(sameSession.id)}id: ${expected.id}\nevent: budgets-updated\ndata: {}\n\n`);
  });

  test("carries the writing tab's X-Tab-Id back, so that tab can tell its own write", async () => {
    const { client } = await newUser();
    const { stream, id } = await connect(client);
    await write(client, "tab-A");
    await write(client);
    await write(client, "");
    // A header value is a byte string: one character per byte, up to U+00FF.
    const odd = 'a tab id with spaces, "quotes", \\backslashes\\ and é';
    await write(client, odd);
    expect(await stream.nextEvent()).toEqual({ id: plus(id, 1), event: "budgets-updated", data: { originTabId: "tab-A" } });
    expect(await stream.nextEvent()).toEqual({ id: plus(id, 2), event: "budgets-updated", data: {} });
    expect(await stream.nextEvent()).toEqual({ id: plus(id, 3), event: "budgets-updated", data: {} });
    expect(await stream.nextEvent()).toEqual({ id: plus(id, 4), event: "budgets-updated", data: { originTabId: odd } });
  });

  test("of one user never reaches another's tabs, and does not move their ids", async () => {
    const writer = await newUser();
    const bystander = await newUser();
    const theirs = await connect(bystander.client);
    const mine = await connect(writer.client);
    await write(writer.client, "writer-1");
    await write(writer.client, "writer-2");
    expect((await mine.stream.nextEvent()).data).toEqual({ originTabId: "writer-1" });
    // The bystander's own write is the first thing their tab hears of, with their own next id.
    await write(bystander.client, "bystander-1");
    expect(await theirs.stream.nextEvent()).toEqual({ id: plus(theirs.id, 1), event: "budgets-updated", data: { originTabId: "bystander-1" } });
  });

  test("that fails, or a read, sends nothing and uses no id", async () => {
    const { client } = await newUser();
    const { stream, id } = await connect(client);
    expect((await client.get("/budgets")).json.status).toBe("success");
    const failed = await client.post("/budget", {}, { headers: { "X-Tab-Id": "failed-write" } });
    expect(failed.json.status).toBe("failed");
    expect((await client.get("/login")).json.status).toBe("success");
    await write(client, "the-first-write");
    expect(await stream.nextEvent()).toEqual({ id: plus(id, 1), event: "budgets-updated", data: { originTabId: "the-first-write" } });
  });

  test("made with an API key reaches the key owner's tabs", async () => {
    const { client } = await newUser();
    const key = await client.post<{ plaintext: string }>("/api-keys", { name: "writer", scopes: ["transactions:suggest"] });
    const { stream, id } = await connect(client);
    const headers = { Authorization: `Bearer ${key.body.plaintext}`, "X-Tab-Id": "a-script" };
    const result = await stack.anonymous().post("/suggest-category", { suggestions: [] }, { headers });
    expect(result.status).toBe(200);
    expect(await stream.nextEvent()).toEqual({ id: plus(id, 1), event: "transactions-updated", data: { originTabId: "a-script" } });
  });

  test("is still heard by a tab whose session has since signed out", async () => {
    const { user, client } = await newUser();
    const { stream, id } = await connect(client);
    expect((await client.delete("/login")).json.status).toBe("success");
    await write(await stack.login(user.username, user.password), "after-sign-out");
    expect(await stream.nextEvent()).toEqual({ id: plus(id, 1), event: "budgets-updated", data: { originTabId: "after-sign-out" } });
  });
});

describe("reconnecting with the last id seen", () => {
  /** A user with three writes behind them: ids `base+1` to `base+3`, tab ids `w1` to `w3`. */
  const withThreeWrites = async () => {
    const { user, client } = await newUser();
    const first = await connect(client);
    for (const tab of ["w1", "w2", "w3"]) await write(client, tab);
    for (let i = 0; i < 3; i++) await first.stream.nextEvent();
    await first.stream.close();
    return { user, client, base: first.id };
  };
  const event = (id: string, tab: string) => `id: ${id}\nevent: budgets-updated\ndata: {"originTabId":"${tab}"}\n\n`;
  /** The whole stream a reconnect gets: everything up to and including `connected`. */
  const reconnect = async (client: ApiClient, options: EventStreamOptions): Promise<string> => {
    const { stream } = await connect(client, options);
    return stream.text;
  };

  test("at the latest id: nothing was missed, nothing is sent again", async () => {
    const { client, base } = await withThreeWrites();
    const tip = plus(base, 3);
    expect(await reconnect(client, { query: { "last-event-id": tip } })).toBe(opening(tip));
    expect(await reconnect(client, { headers: { "Last-Event-ID": tip } })).toBe(opening(tip));
  });

  test("behind the latest id: the events missed are sent again, in order, before `connected`", async () => {
    const { client, base } = await withThreeWrites();
    const tip = plus(base, 3);
    expect(await reconnect(client, { query: { "last-event-id": plus(base, 2) } })).toBe(`: connected\n\n${event(tip, "w3")}${opening(tip).slice(13)}`);
    expect(await reconnect(client, { query: { "last-event-id": plus(base, 1) } })).toBe(
      `: connected\n\n${event(plus(base, 2), "w2")}${event(tip, "w3")}${opening(tip).slice(13)}`,
    );
    // From the id the server started at, every event so far.
    expect(await reconnect(client, { headers: { "Last-Event-ID": base } })).toBe(
      `: connected\n\n${event(plus(base, 1), "w1")}${event(plus(base, 2), "w2")}${event(tip, "w3")}${opening(tip).slice(13)}`,
    );
    await stack.waitFor(() => stack.logs.some((line) => line.includes("SSE subscribed") && line.includes('"replayed":3,"retryFull":false')), {
      what: "the replay to be logged",
    });
  });

  test("a replayed tab then hears the next write once", async () => {
    const { client, base } = await withThreeWrites();
    const { stream } = await connect(client, { query: { "last-event-id": plus(base, 2) } });
    await write(client, "w4");
    expect(await stream.nextEvent()).toEqual({ id: plus(base, 4), event: "budgets-updated", data: { originTabId: "w4" } });
    expect(stream.text).toBe(`: connected\n\n${event(plus(base, 3), "w3")}${opening(plus(base, 3)).slice(13)}${event(plus(base, 4), "w4")}`);
  });

  test("the header is read before the query parameter, even when it is empty", async () => {
    const { client, base } = await withThreeWrites();
    const tip = plus(base, 3);
    const both = await reconnect(client, { headers: { "Last-Event-ID": plus(base, 2) }, query: { "last-event-id": tip } });
    expect(both).toBe(`: connected\n\n${event(tip, "w3")}${opening(tip).slice(13)}`);
    // An empty header is still the header: the tab is taken to have no id at all.
    const empty = await reconnect(client, { headers: { "Last-Event-ID": "" }, query: { "last-event-id": tip } });
    expect(empty).toBe(`: connected\n\n${RETRY_FULL}${opening(tip).slice(13)}`);
  });

  test("with no id, after writes the tab never heard of: it is told to fetch everything again", async () => {
    const { client, base } = await withThreeWrites();
    const tip = plus(base, 3);
    const expected = `: connected\n\n${RETRY_FULL}${opening(tip).slice(13)}`;
    expect(await reconnect(client, {})).toBe(expected);
    expect(await reconnect(client, { query: { "last-event-id": "" } })).toBe(expected);
    // Given twice, the parameter is no id.
    expect(await reconnect(client, { query: { "last-event-id": [tip, tip] } })).toBe(expected);
    await stack.waitFor(() => stack.logs.some((line) => line.includes("SSE subscribed") && line.includes('"replayed":0,"retryFull":true')), {
      what: "the resync to be logged",
    });
  });

  test("with an id that cannot be placed: it is told to fetch everything again", async () => {
    const { client, base } = await withThreeWrites();
    const tip = plus(base, 3);
    const expected = `: connected\n\n${RETRY_FULL}${opening(tip).slice(13)}`;
    for (const id of [plus(tip, 1), plus(tip, 1000), plus(base, -1), "0", "1", "-5", "abc", "NaN", "Infinity", "12abc", " ", "9".repeat(30)]) {
      expect(await reconnect(client, { query: { "last-event-id": id } })).toBe(expected);
    }
  });

  test("an id is read as a whole number, with whatever follows it ignored", async () => {
    const { client, base } = await withThreeWrites();
    const tip = plus(base, 3);
    const covered = `: connected\n\n${event(tip, "w3")}${opening(tip).slice(13)}`;
    for (const id of [`${plus(base, 2)}.9`, `${plus(base, 2)}abc`, `  ${plus(base, 2)}`, `+${plus(base, 2)}`]) {
      // Not compared across servers: the id sits in the request's own URL, run together with other
      // characters, where the comparison cannot tell it from text that should be the same.
      expect(await reconnect(client, { query: { "last-event-id": id }, noCompare: true })).toBe(covered);
    }
  });
});

describe("reconnecting before any write", () => {
  test("at the starting id, or with none: there is nothing to catch up on", async () => {
    const { client } = await newUser();
    const first = await connect(client);
    await first.stream.close();
    for (const options of [{}, { query: { "last-event-id": first.id } }, { headers: { "Last-Event-ID": first.id } }]) {
      const { stream } = await connect(client, options);
      expect(stream.text).toBe(opening(first.id));
    }
  });

  test("with any other id: it is told to fetch everything again", async () => {
    const { client } = await newUser();
    const first = await connect(client);
    await first.stream.close();
    const expected = `: connected\n\n${RETRY_FULL}${opening(first.id).slice(13)}`;
    for (const id of [plus(first.id, -1), plus(first.id, 1), "0", "soon", "-1"]) {
      const { stream } = await connect(client, { query: { "last-event-id": id } });
      expect(stream.text).toBe(expected);
    }
    const { stream } = await connect(client, { headers: { "Last-Event-ID": "not-an-id" }, query: { "last-event-id": first.id } });
    expect(stream.text).toBe(expected);
  });
});

describe("the cap on open streams", () => {
  test("is twenty for a user, across their sessions; the next is refused until one closes", async () => {
    const { user, client } = await newUser();
    const second = await stack.login(user.username, user.password);
    const opened: EventStream[] = [];
    for (let i = 0; i < 20; i++) opened.push((await connect(i % 2 === 0 ? client : second)).stream);

    const sid = client.cookies.get("session_id");
    const refused = await open(client);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ status: "failed", message: "Too many open event streams for this user." });
    expect(refused.headers.get("content-type")).toBe("application/json");
    // An ordinary answer, unlike the stream: the session cookie is refreshed.
    expect(refused.headers.getSetCookie()).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);
    const refusedAgain = await open(second, { query: { "last-event-id": "1" } });
    expect(refusedAgain.status).toBe(429);
    await refusedAgain.json();

    // Someone else is not held back by it.
    const other = await newUser();
    expect((await open(other.client)).status).toBe(200);

    // One tab closes; once the server has noticed, there is room for one more, and only one.
    await opened[0].close();
    const reopened = await stack.waitFor(
      async () => {
        const attempt = await openEventStream(client, { noCompare: true });
        streams.push(attempt);
        if (attempt.status === 200) return attempt;
        await attempt.json();
        return undefined;
      },
      { what: "the closed tab's place to free up" },
    );
    await reopened?.next((block) => block.event === "connected");
    const full = await open(client);
    expect(full.status).toBe(429);
    await full.json();
  });
});

describe("after a restart", () => {
  test("open streams end, ids start over from a later point, and an id from before is told to fetch everything again", async () => {
    const { user, client } = await newUser();
    const before = await connect(client);
    await stack.restart();
    await stack.waitFor(() => before.stream.ended, { what: "the open stream to end with the server" });

    // Sessions are stored, so the same cookie still signs in.
    const after = await connect(client);
    expect(Number(after.id)).toBeGreaterThan(Number(before.id));
    expect(after.stream.text).toBe(opening(after.id));
    await after.stream.close();

    const resumed = await connect(client, { query: { "last-event-id": before.id } });
    expect(resumed.stream.text).toBe(`: connected\n\n${RETRY_FULL}${opening(after.id).slice(13)}`);
    const viaHeader = await connect(await stack.login(user.username, user.password), { headers: { "Last-Event-ID": before.id } });
    expect(viaHeader.stream.text).toBe(`: connected\n\n${RETRY_FULL}${opening(after.id).slice(13)}`);
  });
});

describe("a quiet stream", () => {
  test("is kept alive with a comment every thirty seconds", async () => {
    const { client } = await newUser();
    const { stream, id } = await connect(client);
    const opened = Date.now();
    const keepalive = await stream.next((block) => block.comment !== undefined, { timeoutMs: 40_000, what: "the keepalive comment" });
    const waited = Date.now() - opened;
    expect(keepalive).toEqual({ comment: "keepalive", raw: ": keepalive" });
    expect(waited).toBeGreaterThanOrEqual(29_000);
    expect(waited).toBeLessThan(36_000);
    expect(stream.text).toBe(`${opening(id)}: keepalive\n\n`);
    expect(stream.ended).toBe(false);
  }, 60_000);
});
