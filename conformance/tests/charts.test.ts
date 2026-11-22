import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { NO_SUCH_ID, uuidQueryCases } from "../harness/query-cases";
import {
  CPI_SERIES_ID,
  seedApiKey,
  seedChart,
  seedCpi,
  setJsonb,
  softDelete,
  storedRow,
  storedRows,
  updatedLater,
  withInsertsDropped,
  type StoredRow,
} from "../harness/seed/budgets";

let stack: Stack;
let admin: ApiClient;
let adminId: string;
/** Another user, signed in: never the owner of what `admin` makes. */
let second: ApiClient;
let secondId: string;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
  adminId = await stack.userId("admin");
  const created = await createUserClient(stack, "second-charter");
  second = created.client;
  secondId = created.user.user_id;
});
afterAll(() => stack.stop());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUCCESS = { status: "success" };
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });

interface Chart {
  chart_id: string;
  name: string | null;
  type: string | null;
  /** JSON text. */
  configuration: string;
}

const newChart = async (client: ApiClient): Promise<string> => (await client.get<{ chart_id: string }>("/new-chart")).body.chart_id;

const stored = async (id: string): Promise<StoredRow> => {
  const row = await storedRow(stack, "charts", id);
  if (!row) throw new Error(`no chart ${id}`);
  return row;
};

const listed = async (client: ApiClient): Promise<Chart[]> => {
  const result = await client.get<Chart[]>("/charts");
  expect(result.status).toBe(200);
  expect(result.json.status).toBe("success");
  return result.body;
};

/** The chart as `GET /charts` lists it for `client`, or `undefined`. */
const listedOne = async (client: ApiClient, id: string): Promise<Chart | undefined> =>
  (await listed(client)).find((chart) => chart.chart_id === id);

const byId = (charts: Chart[]): Chart[] => [...charts].sort((a, b) => a.chart_id.localeCompare(b.chart_id));

const post = (body: unknown, client: ApiClient = admin) => client.post("/chart", body);

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

/** A user of their own, so what they list is exactly what the test gave them. */
const freshUser = async (name: string): Promise<{ client: ApiClient; user_id: string }> => {
  const { client, user } = await createUserClient(stack, name);
  return { client, user_id: user.user_id };
};

describe("a caller without a session", () => {
  let chart_id: string;
  beforeAll(async () => {
    chart_id = await seedChart(stack, adminId);
  });

  const requests = (): [string, string, unknown?][] => [
    ["GET", "/charts"],
    ["GET", "/new-chart"],
    ["POST", "/chart", { chart_id, name: "Taken" }],
    ["DELETE", `/chart?id=${chart_id}`],
    ["GET", "/inflation"],
  ];

  test("is refused on every route, and nothing is created, changed or deleted", async () => {
    const before = await storedRows(stack, "charts");
    const anonymous = stack.anonymous();
    for (const [method, path, body] of requests()) {
      const result = await anonymous.request(method, path, { body });
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual(failed("Not authenticated."));
      expect(result.setCookies).toEqual([]);
    }
    expect(await storedRows(stack, "charts")).toEqual(before);
  });

  test("is refused all the same with an API key: these routes take a session only", async () => {
    const key = await seedApiKey(stack, adminId, ["transactions:suggest", "charts:read", "charts:write"]);
    const before = await storedRows(stack, "charts");
    const keyed = stack.anonymous();
    for (const [method, path, body] of requests()) {
      const result = await keyed.request(method, path, { body, headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.41.0.1" } });
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual(failed("Not authenticated."));
      expect(result.setCookies).toEqual([]);
    }
    expect(await storedRows(stack, "charts")).toEqual(before);
    // The key was not even looked up.
    expect((await stack.db.rows("api_keys", { user_id: adminId })).map((row) => row.last_used_at)).toEqual([null]);
  });
});

describe("GET /new-chart", () => {
  test("creates a balance chart with the defaults for the caller, and answers with its id alone", async () => {
    const result = await admin.get<{ chart_id: string }>("/new-chart");
    expect(result.status).toBe(200);
    const { chart_id } = result.body;
    expect(chart_id).toMatch(UUID);
    expect(result.json).toEqual({ status: "success", body: { chart_id } });
    const row = await stored(chart_id);
    expect(row).toEqual({
      chart_id,
      user_id: adminId,
      name: "New Chart",
      type: "balance_chart",
      configuration: {},
      updated: expect.any(String),
      is_deleted: false,
    });
    expect(Math.abs(Date.parse(row.updated as string) - Date.now())).toBeLessThan(60_000);
    expect(await listedOne(admin, chart_id)).toEqual({ chart_id, name: "New Chart", type: "balance_chart", configuration: "{}" });
  });

  test("takes nothing from the query, and makes a new chart every time", async () => {
    const query = { chart_id: NO_SUCH_ID, name: "Mine", type: "flow_chart", configuration: '{"account_ids":["a"]}' };
    const first = await admin.get<{ chart_id: string }>("/new-chart", { query });
    const again = await admin.get<{ chart_id: string }>("/new-chart", { query });
    expect(first.json).toEqual({ status: "success", body: { chart_id: expect.stringMatching(UUID) } });
    expect(again.json).toEqual({ status: "success", body: { chart_id: expect.stringMatching(UUID) } });
    expect(first.body.chart_id).not.toBe(NO_SUCH_ID);
    expect(again.body.chart_id).not.toBe(first.body.chart_id);
    for (const { body } of [first, again]) {
      expect(await listedOne(admin, body.chart_id)).toEqual({
        chart_id: body.chart_id,
        name: "New Chart",
        type: "balance_chart",
        configuration: "{}",
      });
    }
  });

  test("answers that it failed when the insert stored no row", async () => {
    const { client, user_id } = await freshUser("no-chart-stored");
    await withInsertsDropped(stack, "charts", async () => {
      const result = await client.get("/new-chart");
      expect(result.status).toBe(200);
      expect(result.json).toEqual(failed("Failed to create chart."));
    });
    expect(await storedRows(stack, "charts", { user_id })).toEqual([]);
  });
});

describe("GET /charts", () => {
  test("lists nothing for a user who has made none", async () => {
    const { client } = await freshUser("no-charts");
    const result = await client.get("/charts");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: [] });
  });

  test("lists the caller's live charts whole, the configuration as JSON text, each column set or not", async () => {
    const { client, user_id } = await freshUser("lists-charts");
    const balance = await seedChart(stack, user_id, {
      name: "Net worth",
      type: "balance_chart",
      configuration: { account_ids: ["acc-1", "acc-2"], budget_ids: [] },
    });
    const empty = await seedChart(stack, user_id, { name: null, type: null, configuration: null, is_deleted: null });
    const list = await seedChart(stack, user_id, { name: "", type: "", configuration: [1, "two", { three: 3 }] });
    // Deleted charts are left out, and so are another user's and one that is nobody's.
    await seedChart(stack, user_id, { is_deleted: true });
    await seedChart(stack, secondId);
    await seedChart(stack, user_id, { user_id: null });

    const result = await client.get<Chart[]>("/charts");
    expect(result.status).toBe(200);
    expect(result.json.status).toBe("success");
    expect(byId(result.body)).toEqual(
      byId([
        // JSONB keeps an object's keys by length, then by byte: that is the order of the text.
        { chart_id: balance, name: "Net worth", type: "balance_chart", configuration: '{"budget_ids":[],"account_ids":["acc-1","acc-2"]}' },
        { chart_id: empty, name: null, type: null, configuration: "null" },
        { chart_id: list, name: "", type: "", configuration: '[1,"two",{"three":3}]' },
      ]),
    );
  });

  test("writes a chart's keys in one order", async () => {
    const { client, user_id } = await freshUser("orders-chart-keys");
    const chart_id = await seedChart(stack, user_id, { name: "Ordered", type: "flow_chart", configuration: { account_ids: [] } });
    const result = await client.get("/charts");
    expect(result.text).toBe(
      `{"status":"success","body":[{"chart_id":"${chart_id}","name":"Ordered","type":"flow_chart","configuration":"{\\"account_ids\\":[]}"}]}`,
    );
    expect(result.headers.get("content-type")).toBe("application/json");
  });

  test("fails as a server error while a chart's configuration is stored as a bare string, number or boolean", async () => {
    const { client, user_id } = await freshUser("broken-configuration");
    const chart_id = await seedChart(stack, user_id);
    await seedChart(stack, user_id);
    const route = "GET /charts";
    expect(alarmsFor(route)).toHaveLength(0);

    for (const json of ['"text"', "5", "true", "false", "0", '""']) {
      await setJsonb(stack, "charts", chart_id, "configuration", json);
      const result = await client.get("/charts");
      expect([json, result.status, result.json]).toEqual([json, 500, SERVER_ERROR]);
      if (json === '"text"') {
        await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
        expect(alarmsFor(route)[0].description).toBe('**Error:** ChartModel validation failed:\nconfiguration: "text" (string)');
        await stack.waitForLog('Route handler error {"method":"GET","path":"/charts"}');
      }
      // Everyone else's list is unaffected.
      expect((await admin.get("/charts")).status).toBe(200);
    }

    // A JSON null in the column reads like an empty one.
    await setJsonb(stack, "charts", chart_id, "configuration", "null");
    const mended = await listed(client);
    expect(mended).toHaveLength(2);
    expect(mended.find((chart) => chart.chart_id === chart_id)?.configuration).toBe("null");
    expect(alarmsFor(route)).toHaveLength(1);
  });
});

describe("POST /chart", () => {
  /** One of the admin's, named by every request that must be refused: none may change it. */
  let id: string;
  let untouched: StoredRow;
  beforeAll(async () => {
    id = await newChart(admin);
    untouched = await stored(id);
  });

  test("needs a JSON object for a body", async () => {
    const bodies: [unknown, string][] = [
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      [[{ chart_id: id, name: "In a list" }], "Request body must be an object"],
      ["name", "Request body must be an object"],
      [5, "Request body must be an object"],
      [0, "Request body must be an object"],
      [true, "Request body must be an object"],
      [false, "Request body must be an object"],
    ];
    for (const [body, message] of bodies) {
      const result = await post(body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    const none = await admin.request("POST", "/chart");
    expect(none.json).toEqual(failed("Request body is required"));
    const notJson = await admin.request("POST", "/chart", { rawBody: "{bad", headers: { "Content-Type": "application/json" } });
    expect(notJson.json).toEqual(failed("Request body is required"));
    const unlabeled = await admin.request("POST", "/chart", {
      rawBody: JSON.stringify({ chart_id: id, name: "Unlabeled" }),
      headers: { "Content-Type": "text/plain" },
    });
    expect(unlabeled.json).toEqual(failed("Request body is required"));
    expect(await stored(id)).toEqual(untouched);
  });

  test("needs chart_id as a string that is a UUID", async () => {
    const ids: [unknown, string][] = [
      [undefined, "Missing required field: chart_id"],
      [null, "Missing required field: chart_id"],
      [5, "Field chart_id must be a string"],
      [0, "Field chart_id must be a string"],
      [true, "Field chart_id must be a string"],
      [{ id }, "Field chart_id must be a string"],
      [[id], "Field chart_id must be a string"],
      ["", "Field chart_id must be a uuid"],
      ["not-a-uuid", "Field chart_id must be a uuid"],
      [id.replace(/-/g, ""), "Field chart_id must be a uuid"],
      [`{${id}}`, "Field chart_id must be a uuid"],
      [` ${id}`, "Field chart_id must be a uuid"],
      [`${id}\n`, "Field chart_id must be a uuid"],
      [`${id}0`, "Field chart_id must be a uuid"],
    ];
    for (const [value, message] of ids) {
      const result = await post({ chart_id: value, name: "Renamed" });
      expect([value, result.status, result.json]).toEqual([value, 200, failed(message)]);
    }
    expect(await stored(id)).toEqual(untouched);
  });

  test("refuses each field of the wrong type or past its column, and a configuration that is not text", async () => {
    const cases: [string, unknown, string][] = [
      ["name", 5, "Field name must be a string"],
      ["name", true, "Field name must be a string"],
      ["name", { text: "Name" }, "Field name must be a string"],
      ["name", ["Name"], "Field name must be a string"],
      ["name", "n".repeat(256), "Field name must be at most 255 characters"],
      // Counted as JavaScript counts a string: two per character outside the basic plane.
      ["name", "😀".repeat(128), "Field name must be at most 255 characters"],
      ["type", 5, "Field type must be a string"],
      ["type", false, "Field type must be a string"],
      ["type", { type: "balance_chart" }, "Field type must be a string"],
      ["type", ["balance_chart"], "Field type must be a string"],
      ["type", "t".repeat(51), "Field type must be at most 50 characters"],
      // The client always sends JSON text, so nothing else is taken, the parsed object included.
      ["configuration", null, "Field configuration must be a string"],
      ["configuration", { account_ids: [], budget_ids: [] }, "Field configuration must be a string"],
      ["configuration", [], "Field configuration must be a string"],
      ["configuration", 5, "Field configuration must be a string"],
      ["configuration", true, "Field configuration must be a string"],
    ];
    for (const [field, value, message] of cases) {
      const result = await post({ chart_id: id, [field]: value });
      expect([field, value, result.status, result.json]).toEqual([field, value, 200, failed(message)]);
    }
    expect(await stored(id)).toEqual(untouched);
  });

  test("names the first thing wrong, the id before the fields in their order", async () => {
    const order: [Record<string, unknown>, string][] = [
      [{ configuration: null, type: 5, name: 5 }, "Missing required field: chart_id"],
      [{ configuration: null, type: 5, name: 5, chart_id: 5 }, "Field chart_id must be a string"],
      [{ configuration: null, type: 5, name: 5, chart_id: "nope" }, "Field chart_id must be a uuid"],
      [{ configuration: null, type: 5, name: 5, chart_id: id }, "Field name must be a string"],
      [{ configuration: null, type: 5, name: null, chart_id: id }, "Field type must be a string"],
      [{ configuration: null, type: null, name: null, chart_id: id }, "Field configuration must be a string"],
    ];
    for (const [body, message] of order) {
      const result = await post(body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    expect(await stored(id)).toEqual(untouched);
  });

  test("writes every field given, the configuration parsed, and nothing else of the row", async () => {
    const target = await newChart(admin);
    const before = await stored(target);
    const configuration = { account_ids: ["acc-1"], budget_ids: ["Unknown"] };
    const result = await post({ chart_id: target, name: "Where it goes", type: "flow_chart", configuration: JSON.stringify(configuration) });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);

    const after = await stored(target);
    expect(after).toEqual({ ...before, name: "Where it goes", type: "flow_chart", configuration, updated: expect.any(String) });
    expect(updatedLater(after, before)).toBe(true);
    expect(await listedOne(admin, target)).toEqual({
      chart_id: target,
      name: "Where it goes",
      type: "flow_chart",
      configuration: '{"budget_ids":["Unknown"],"account_ids":["acc-1"]}',
    });
  });

  test("stores each kind of chart with the configuration its kind carries, and any other type text as it is", async () => {
    const target = await newChart(admin);
    const kinds: [string, unknown][] = [
      ["balance_chart", { account_ids: ["acc-checking", "acc-savings"], budget_ids: [] }],
      ["flow_chart", { account_ids: [], budget_ids: ["0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10", "Unknown"] }],
      [
        "projection_chart",
        {
          account_ids: ["acc-brokerage"],
          auto_saving_config: true,
          auto_goal_config: false,
          budget_ids: ["0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10"],
          initial_saving: { amount: 125000.75, amountAsOf: "2026-01-01T00:00:00.000Z" },
          living_cost: { amount: 4200, amountAsOf: "2026-01-01T00:00:00.000Z", taxRate: 0.22 },
          contribution: 1500,
          anual_percentage_yield: 1.07,
          year_over_year_inflation: 1.0261,
        },
      ],
      // The type is free text of at most 50 characters; nothing checks it is one the client knows.
      ["anything at all", { whatever: true }],
      ["t".repeat(50), {}],
      ["", {}],
    ];
    for (const [type, configuration] of kinds) {
      const result = await post({ chart_id: target, type, configuration: JSON.stringify(configuration) });
      expect([type, result.status, result.json]).toEqual([type, 200, SUCCESS]);
      const row = await stored(target);
      expect([row.type, row.configuration]).toEqual([type, configuration]);
      const shown = await listedOne(admin, target);
      expect(shown?.type).toBe(type);
      expect(JSON.parse(shown?.configuration ?? "null")).toEqual(configuration);
    }
  });

  test("changes only the fields a body carries, and null clears the name and the type", async () => {
    const target = await newChart(admin);
    expect((await post({ chart_id: target, name: "Before", type: "flow_chart", configuration: '{"account_ids":[]}' })).json).toEqual(SUCCESS);
    const before = await stored(target);

    const steps: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ name: "Renamed" }, { name: "Renamed" }],
      [{ type: "projection_chart" }, { type: "projection_chart" }],
      [{ configuration: '{"budget_ids":["b"]}' }, { configuration: { budget_ids: ["b"] } }],
      [{ name: null }, { name: null }],
      [{ type: null }, { type: null }],
      // A chart's name may be blank, unlike a budget's.
      [{ name: "" }, { name: "" }],
      [{ name: "   " }, { name: "   " }],
      [{ name: "n".repeat(255) }, { name: "n".repeat(255) }],
      // 255 as JavaScript counts: 127 characters outside the basic plane and one inside.
      [{ name: `${"😀".repeat(127)}x` }, { name: `${"😀".repeat(127)}x` }],
    ];
    let expected = before;
    for (const [step, change] of steps) {
      const result = await post({ chart_id: target, ...step });
      expect([step, result.status, result.json]).toEqual([step, 200, SUCCESS]);
      const after = await stored(target);
      expect(after).toEqual({ ...expected, ...change, updated: expect.any(String) });
      expect(updatedLater(after, expected)).toBe(true);
      expected = after;
    }
    expect(await listedOne(admin, target)).toEqual({
      chart_id: target,
      name: `${"😀".repeat(127)}x`,
      type: null,
      configuration: '{"budget_ids":["b"]}',
    });
  });

  test("writes nothing when the body names no field it writes, whatever else it carries", async () => {
    const target = await newChart(admin);
    const before = await stored(target);
    const bodies: Record<string, unknown>[] = [
      { chart_id: target },
      {
        chart_id: target,
        user_id: secondId,
        is_deleted: true,
        updated: "2000-01-01T00:00:00.000Z",
        Name: "Wrong case",
        nonsense: { name: "Nested" },
      },
    ];
    for (const body of bodies) {
      const result = await post(body);
      expect([body, result.status, result.json]).toEqual([body, 200, SUCCESS]);
      expect(await stored(target)).toEqual(before);
    }
  });

  test("parses the configuration text and lists it back as JavaScript would write it", async () => {
    const target = await newChart(admin);
    // What is sent, what the column then holds, and the text `GET /charts` gives.
    const shapes: [string, unknown, string][] = [
      ["{}", {}, "{}"],
      ['  {"a" : 1 }\n', { a: 1 }, '{"a":1}'],
      ["[]", [], "[]"],
      ['[1,2,{"a":1},[]]', [1, 2, { a: 1 }, []], '[1,2,{"a":1},[]]'],
      // Numbers are held as JavaScript holds them.
      [
        '{"n":[1e21,1e-7,-0,1.0,12345678901234567890,0.1234567890123456789,1E+2,5e-324]}',
        { n: [1e21, 1e-7, 0, 1, 12345678901234567000, 0.12345678901234568, 100, 5e-324] },
        '{"n":[1e+21,1e-7,0,1,12345678901234567000,0.12345678901234568,100,5e-324]}',
      ],
      // Of a repeated key the last value stays, where the first stood.
      ['{"a":1,"b":2,"a":3}', { a: 3, b: 2 }, '{"a":3,"b":2}'],
      // Whole-number keys come first, in number order; the rest follow in the column's own order.
      ['{"b":1,"10":2,"2":3,"a":{"z":1,"1":2},"01":4,"-1":5}', { b: 1, "10": 2, "2": 3, a: { z: 1, "1": 2 }, "01": 4, "-1": 5 }, '{"2":3,"10":2,"a":{"1":2,"z":1},"b":1,"-1":5,"01":4}'],
      ['{"__proto__":{"x":1},"constructor":1,"toString":null}', JSON.parse('{"__proto__":{"x":1},"constructor":1,"toString":null}'), '{"toString":null,"__proto__":{"x":1},"constructor":1}'],
      [
        '{"s":"ünï©ödé 😀 \\u0001\\u001f\\u007f\\u2028 \\" \\\\ \\n \\/ \\ud83d\\ude00"}',
        { s: 'ünï©ödé 😀 \u0001\u001f\u007f  " \\ \n / 😀' },
        '{"s":"ünï©ödé 😀 \\u0001\\u001f\u007f  \\" \\\\ \\n / 😀"}',
      ],
      // Text that is itself a JSON string is handed to Postgres as that string's text, and read there as JSON.
      ['"{\\"a\\":1}"', { a: 1 }, '{"a":1}'],
      ['"[1,2]"', [1, 2], "[1,2]"],
    ];
    for (const [sent, held, text] of shapes) {
      const result = await post({ chart_id: target, configuration: sent });
      expect([sent, result.status, result.json]).toEqual([sent, 200, SUCCESS]);
      expect([sent, (await stored(target)).configuration]).toEqual([sent, held]);
      expect([sent, (await listedOne(admin, target))?.configuration]).toEqual([sent, text]);
    }
  });

  test("empties the column for the text null, and stores a JSON null for the text of the string null", async () => {
    const target = await newChart(admin);
    const kind = async () =>
      stack.db.one<{ empty: boolean; kind: string | null }>(
        "SELECT configuration IS NULL AS empty, jsonb_typeof(configuration) AS kind FROM charts WHERE chart_id = $1",
        [target],
      );
    expect((await post({ chart_id: target, configuration: "null" })).json).toEqual(SUCCESS);
    expect(await kind()).toEqual({ empty: true, kind: null });
    expect((await listedOne(admin, target))?.configuration).toBe("null");

    expect((await post({ chart_id: target, configuration: '"null"' })).json).toEqual(SUCCESS);
    expect(await kind()).toEqual({ empty: false, kind: "null" });
    expect((await listedOne(admin, target))?.configuration).toBe("null");
  });

  test("stores a bare number, boolean or string when the text is a JSON string of one, and the list then fails", async () => {
    const { client } = await freshUser("stores-a-scalar");
    const target = await newChart(client);
    const kind = async () =>
      (await stack.db.one<{ kind: string }>("SELECT jsonb_typeof(configuration) AS kind FROM charts WHERE chart_id = $1", [target]))?.kind;
    for (const [sent, held, kindOf] of [
      ['"5"', 5, "number"],
      ['"true"', true, "boolean"],
      ['"\\"text\\""', "text", "string"],
    ] as const) {
      const result = await post({ chart_id: target, configuration: sent }, client);
      expect([sent, result.status, result.json]).toEqual([sent, 200, SUCCESS]);
      expect([sent, (await stored(target)).configuration, await kind()]).toEqual([sent, held, kindOf]);
      const list = await client.get("/charts");
      expect([sent, list.status, list.json]).toEqual([sent, 500, SERVER_ERROR]);
    }
    // Writing an object back mends it: the write never reads the row.
    expect((await post({ chart_id: target, configuration: "{}" }, client)).json).toEqual(SUCCESS);
    expect(await listed(client)).toEqual([{ chart_id: target, name: "New Chart", type: "balance_chart", configuration: "{}" }]);
  });

  test("fails as a server error, and changes nothing, on configuration text Postgres will not take as JSON", async () => {
    const target = await newChart(admin);
    expect((await post({ chart_id: target, name: "Kept", configuration: '{"kept":true}' })).json).toEqual(SUCCESS);
    const before = await stored(target);
    const route = "POST /chart";
    expect(alarmsFor(route)).toHaveLength(0);

    // Text that parses to a bare boolean or number is bound as one, which a JSONB column refuses.
    const refused = await post({ chart_id: target, name: "Changed", configuration: "true" });
    expect(refused.status).toBe(500);
    expect(refused.json).toEqual(SERVER_ERROR);
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route)[0].description).toBe(
      '**Error:** column "configuration" is of type jsonb but expression is of type boolean',
    );
    await stack.waitForLog(`Failed to update chart {"chartId":"${target}"}`);
    await stack.waitForLog('Route handler error {"method":"POST","path":"/chart"}');

    const texts = [
      "false",
      "5",
      "0",
      "-1.5",
      "12345678901",
      // A JSON string whose text is not JSON.
      '"abc"',
      '""',
      // JSONB holds no NUL, and no half of a surrogate pair.
      '{"s":"x\\u0000y"}',
      '{"s":"x\\ud800y"}',
      // Not JSON at all. What the alarm would say of these differs by runtime
      // (it is the parser's own message), and one alarm a minute per route
      // keeps them quiet here: the alarm above has just gone out.
      "",
      " ",
      "{bad",
      "{'a':1}",
      '{"a":1,}',
      '{"a":1} trailing',
      "[1,]",
      "undefined",
      "NaN",
      "01",
      '{"a":"\t"}',
    ];
    for (const configuration of texts) {
      const result = await post({ chart_id: target, name: "Changed", configuration });
      expect([configuration, result.status, result.json]).toEqual([configuration, 500, SERVER_ERROR]);
    }
    const nulName = await post({ chart_id: target, name: "nul\u0000byte" });
    expect(nulName.status).toBe(500);
    expect(nulName.json).toEqual(SERVER_ERROR);

    expect(await stored(target)).toEqual(before);
    expect(alarmsFor(route)).toHaveLength(1);
  });

  test("answers success and changes nothing for a chart that is missing, deleted or another user's", async () => {
    const changes = { name: "Taken over", type: "flow_chart", configuration: '{"taken":true}' };

    expect((await post({ chart_id: NO_SUCH_ID, ...changes })).json).toEqual(SUCCESS);
    expect(await storedRow(stack, "charts", NO_SUCH_ID)).toBeUndefined();

    const others = await newChart(admin);
    const othersBefore = await stored(others);
    const result = await post({ chart_id: others, ...changes }, second);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);
    expect(await stored(others)).toEqual(othersBefore);
    // The id in upper case is the same chart, and its owner changes it.
    expect((await post({ chart_id: others.toUpperCase(), name: "Mine still" })).json).toEqual(SUCCESS);
    expect((await stored(others)).name).toBe("Mine still");

    const deleted = await newChart(admin);
    await softDelete(stack, "charts", deleted);
    const deletedBefore = await stored(deleted);
    expect((await post({ chart_id: deleted, ...changes })).json).toEqual(SUCCESS);
    expect(await stored(deleted)).toEqual(deletedBefore);
  });
});

describe("DELETE /chart", () => {
  const remove = (id: string, client: ApiClient = admin) => client.delete("/chart", { query: { id } });

  test("needs one id that is a UUID", async () => {
    const id = await newChart(admin);
    const before = await stored(id);
    for (const [query, message] of uuidQueryCases("id")) {
      const result = await admin.request("DELETE", `/chart${query}`);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
    // A body is not where the id is read from.
    const inBody = await admin.request("DELETE", "/chart", { body: { id } });
    expect(inBody.json).toEqual(failed("Missing required parameter: id"));
    expect(await stored(id)).toEqual(before);
  });

  test("marks the caller's chart deleted, and it is no longer listed", async () => {
    const id = await newChart(admin);
    const before = await stored(id);
    const result = await remove(id);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);
    const after = await stored(id);
    expect(after).toEqual({ ...before, is_deleted: true, updated: expect.any(String) });
    expect(updatedLater(after, before)).toBe(true);
    expect(await listedOne(admin, id)).toBeUndefined();

    // Deleting it again, by its id in upper case, answers the same and stamps the row again.
    expect((await remove(id.toUpperCase())).json).toEqual(SUCCESS);
    const again = await stored(id);
    expect(again).toEqual({ ...after, updated: expect.any(String) });
    expect(updatedLater(again, after)).toBe(true);
  });

  test("answers success and deletes nothing for an id no chart has, or another user's chart", async () => {
    const others = await newChart(admin);
    const before = await storedRows(stack, "charts");
    for (const [id, client] of [
      [NO_SUCH_ID, admin],
      [others, second],
    ] as const) {
      const result = await remove(id, client);
      expect(result.status).toBe(200);
      expect(result.json).toEqual(SUCCESS);
    }
    expect(await storedRows(stack, "charts")).toEqual(before);
    expect((await listedOne(admin, others))?.chart_id).toBe(others);
  });
});

describe("a second user", () => {
  test("sees none of the first user's charts, and the first none of theirs", async () => {
    const [mine, theirs] = [await newChart(admin), await newChart(second)];
    const [adminIds, secondIds] = [(await listed(admin)).map((c) => c.chart_id), (await listed(second)).map((c) => c.chart_id)];
    expect(adminIds).toContain(mine);
    expect(adminIds).not.toContain(theirs);
    expect(secondIds).toContain(theirs);
    expect(secondIds).not.toContain(mine);
    // Everything listed is stored as the caller's own.
    for (const [ids, owner] of [
      [adminIds, adminId],
      [secondIds, secondId],
    ] as const) {
      const owned = (await storedRows(stack, "charts", { user_id: owner })).map((row) => row.chart_id);
      for (const id of ids) expect(owned).toContain(id);
    }
  });
});

describe("GET /inflation", () => {
  interface Inflation {
    year_over_year_inflation: number;
    from: string;
    to: string;
    series_id: string;
  }

  /** Replaces what is stored with these months of the CPI series, written in this order. */
  const months = async (...rows: [date: string, value: number | string][]): Promise<void> => {
    await stack.db.query("DELETE FROM cpi_snapshots");
    for (const [date, value] of rows) await seedCpi(stack, date, value);
  };

  /** The compound yearly rate between two index values `span` months apart, as the server computes it. */
  const rate = (latest: number, base: number, span: number): number => Math.pow(latest / base, 12 / span);

  const answer = (year_over_year_inflation: number, from: string, to: string) => ({
    status: "success",
    body: { year_over_year_inflation, from, to, series_id: CPI_SERIES_ID },
  });
  const NOTHING = { status: "success", body: null };

  const get = async (client: ApiClient = admin) => {
    const result = await client.get<Inflation | null>("/inflation");
    expect(result.status).toBe(200);
    return result;
  };

  test("answers null while less than a year of months is stored", async () => {
    await months();
    expect((await get()).json).toEqual(NOTHING);
    expect((await get()).text).toBe('{"status":"success","body":null}');

    await months(["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(NOTHING);

    // Eleven months apart.
    await months(["2025-10-01", 315.2], ["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(NOTHING);

    await months(["2025-10-01", 315.2], ["2025-11-01", 316], ["2026-08-01", 323], ["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(NOTHING);

    // Two rows of one month are no span at all.
    await months(["2026-09-01", 324.8]);
    await seedCpi(stack, "2026-09-15", 330, { id: "same-month" });
    expect((await get()).json).toEqual(NOTHING);
  });

  test("is the latest month over the one a year before, once exactly a year is stored", async () => {
    await months(["2025-09-01", 300], ["2026-09-01", 309]);
    const result = await get();
    expect(result.json).toEqual(answer(309 / 300, "2025-09", "2026-09"));
    expect(result.body?.year_over_year_inflation).toBe(1.03);
    expect(result.text).toBe(
      '{"status":"success","body":{"year_over_year_inflation":1.03,"from":"2025-09","to":"2026-09","series_id":"CUUR0000SA0"}}',
    );
    // Any signed-in user gets the same answer: the series is nobody's.
    expect((await get(second)).json).toEqual(answer(1.03, "2025-09", "2026-09"));
  });

  test("compounds over the months between the earliest and the latest stored month", async () => {
    const spans: [from: string, months: number][] = [
      ["2025-08-01", 13],
      ["2024-09-01", 24],
      ["2023-09-01", 36],
      ["2020-02-01", 79],
      ["2016-10-01", 119],
      ["2016-09-01", 120],
    ];
    for (const [from, span] of spans) {
      await months([from, 241.428], ["2026-09-01", 324.8]);
      expect([from, (await get()).json]).toEqual([from, answer(rate(324.8, 241.428, span), from.slice(0, 7), "2026-09")]);
    }
    // Six decimals of the index are kept, and months between the two ends do not matter.
    await months(["2016-09-01", "241.428123"], ["2019-03-01", 1], ["2022-06-01", 999999999.999999], ["2026-09-01", "324.800001"]);
    expect((await get()).json).toEqual(answer(rate(324.800001, 241.428123, 120), "2016-09", "2026-09"));
  });

  test("reaches back fifteen years from the latest stored month, that month included", async () => {
    // Exactly fifteen years back is inside the window.
    await months(["2011-09-01", 226.889], ["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(answer(rate(324.8, 226.889, 180), "2011-09", "2026-09"));

    // A month earlier is outside it: the next stored month is the base.
    await months(["2011-08-01", 100], ["2011-09-01", 226.889], ["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(answer(rate(324.8, 226.889, 180), "2011-09", "2026-09"));

    await months(["1990-01-01", 127.4], ["2011-08-01", 226.545], ["2012-03-01", 229.392], ["2020-01-01", 257.971], ["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(answer(rate(324.8, 229.392, 174), "2012-03", "2026-09"));

    // The window hangs on the latest stored month, not on today.
    await months(["1989-12-01", 126.1], ["1990-01-01", 127.4], ["2005-01-01", 190.7]);
    expect((await get()).json).toEqual(answer(rate(190.7, 127.4, 180), "1990-01", "2005-01"));
  });

  test("answers null when the latest month is the only one inside its window, or the base is under a year back", async () => {
    await months(["2000-01-01", 168.8], ["2011-08-01", 226.545], ["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(NOTHING);

    await months(["2000-01-01", 168.8], ["2025-10-01", 315.2], ["2026-09-01", 324.8]);
    expect((await get()).json).toEqual(NOTHING);
  });

  test("reads the months in date order, whatever order they were stored in", async () => {
    await months(["2026-09-01", 324.8], ["2016-09-01", 241.428], ["2021-09-01", 274.31], ["2014-09-01", 238.031]);
    expect((await get()).json).toEqual(answer(rate(324.8, 238.031, 144), "2014-09", "2026-09"));
  });

  test("of two rows in one month, takes the later as the latest and the earlier as the base", async () => {
    await months(["2016-09-01", 200], ["2026-09-01", 220]);
    await seedCpi(stack, "2026-09-15", 242, { id: "later-in-the-latest-month" });
    await seedCpi(stack, "2016-09-20", 210, { id: "later-in-the-base-month" });
    expect((await get()).json).toEqual(answer(rate(242, 200, 120), "2016-09", "2026-09"));
  });

  test("counts only positive values of its own series, in years of four digits", async () => {
    await months(["2018-09-01", 250], ["2026-09-01", 300]);
    // Earlier in the window, but not usable: either would be the base if it counted.
    await seedCpi(stack, "2016-09-01", 0);
    await seedCpi(stack, "2017-09-01", -5);
    // Another series is not read at all.
    await seedCpi(stack, "2015-09-01", 100, { series_id: "CUSR0000SA0" });
    await seedCpi(stack, "2027-09-01", 400, { series_id: "CUSR0000SA0" });
    // Later than everything, but its year does not read as one: it would be the latest if it counted.
    await seedCpi(stack, "10000-01-01", 500, { id: "far-future" });
    expect((await get()).json).toEqual(answer(rate(300, 250, 96), "2018-09", "2026-09"));

    // With one usable month left there is nothing to compare.
    await stack.db.query("DELETE FROM cpi_snapshots WHERE cpi_snapshot_id = $1", [`${CPI_SERIES_ID}-2018-09`]);
    expect((await get()).json).toEqual(NOTHING);
  });

  test("never asks the Bureau of Labor Statistics", async () => {
    const before = stack.upstream.bls.seen().length;
    await months(["2025-09-01", 300], ["2026-09-01", 309]);
    for (let i = 0; i < 3; i++) await get();
    expect(stack.upstream.bls.seen()).toHaveLength(before);
  });
});
