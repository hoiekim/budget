/**
 * `GET /institutions`: stored institutions, and Plaid as the fallback for ids
 * that are not stored, bounded per request, per user and per process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PLAID_PRODUCTION_HOST,
  PLAID_SANDBOX_HOST,
  createUserClient,
  startStack,
  type ApiClient,
  type Stack,
} from "../harness";
import { seedApiKey } from "../harness/seed/budgets";
import { rowOf, rowsOf, seedInstitution } from "../harness/seed/accounts";

let stack: Stack;
let admin: ApiClient;
let adminId: string;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
  adminId = await stack.userId("admin");
});
afterAll(() => stack.stop());

const failed = (message: string) => ({ status: "failed", message });
const PLAID_HEADERS = {
  "plaid-client-id": "conformance-plaid-client",
  "plaid-secret": "conformance-plaid-production",
  "content-type": "application/json",
};

type Institution = Record<string, unknown>;

/** What the API answers for a stored institution: its id and name, the rest of Plaid's shape empty. */
const storedJson = (institution_id: string, name: string | null): Institution => ({
  institution_id,
  name,
  products: [],
  country_codes: [],
  url: null,
  primary_color: null,
  logo: null,
  routing_numbers: [],
  oauth: false,
  status: null,
});

/** What the API answers for an institution Plaid resolved: the fields of `JSONInstitution` Plaid sent. */
const fetchedJson = (plaid: Institution): Institution => {
  const json: Institution = {};
  for (const key of ["institution_id", "name", "products", "country_codes", "url", "primary_color", "logo", "routing_numbers", "oauth", "status"]) {
    if (plaid[key] !== undefined) json[key] = plaid[key];
  }
  return json;
};

const byId = (rows: Institution[]) => [...rows].sort((a, b) => String(a.institution_id).localeCompare(String(b.institution_id)));

const get = (ids: string, client: ApiClient = admin) => client.get<Institution[]>("/institutions", { query: { ids } });

/** Answers the ids, sorted, and checks the request succeeded. */
const resolved = async (ids: string, client: ApiClient = admin): Promise<Institution[]> => {
  const result = await get(ids, client);
  expect(result.status).toBe(200);
  expect(result.json.status).toBe("success");
  return byId(result.body);
};

const lookups = () => stack.upstream.plaid.calls("/institutions/get_by_id");
const lookedUp = (since: number) => lookups().slice(since).map((call) => call.body.institution_id);

/** A user of their own: the Plaid-fallback budget is per user. */
const freshUser = async (name: string): Promise<{ client: ApiClient; user_id: string }> => {
  const { client, user } = await createUserClient(stack, name);
  return { client, user_id: user.user_id };
};

describe("a caller without a session", () => {
  test("is refused, with or without an API key, and Plaid is not asked", async () => {
    await seedInstitution(stack, "ins_anon");
    const key = await seedApiKey(stack, adminId, ["transactions:suggest", "institutions:read"]);
    const before = lookups().length;
    for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.51.0.1" }] as Record<string, string>[]) {
      const result = await stack.anonymous().get("/institutions", { query: { ids: "ins_anon,ins_missing" }, headers });
      expect(result.status).toBe(401);
      expect(result.json).toEqual(failed("Not authenticated."));
    }
    expect(lookups()).toHaveLength(before);
  });
});

describe("validation", () => {
  test("needs one ids parameter with something in it", async () => {
    for (const [query, message] of [
      ["", "Missing required parameter: ids"],
      ["?id=ins_1", "Missing required parameter: ids"],
      ["?ids=ins_1&ids=ins_2", "Parameter ids must be a single value, not an array"],
      ["?ids=", "Parameter ids cannot be empty"],
      ["?ids=%20%09", "Parameter ids cannot be empty"],
    ]) {
      const result = await admin.get(`/institutions${query}`);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
  });

  test("takes at most 100 ids, counted before duplicates are dropped but after blanks and Unknown are", async () => {
    const before = lookups().length;
    const tooMany = Array.from({ length: 101 }, (_, i) => `ins_cap_${i}`).join(",");
    expect((await get(tooMany)).json).toEqual(failed("Parameter ids accepts at most 100 institution ids per request"));
    expect((await get(Array(101).fill("ins_same").join(","))).json).toEqual(failed("Parameter ids accepts at most 100 institution ids per request"));

    // Exactly 100, all stored, with blanks and the Unknown sentinel beside them.
    const hundred = Array.from({ length: 100 }, (_, i) => `ins_cap_${String(i).padStart(3, "0")}`);
    for (const id of hundred) await seedInstitution(stack, id, { name: `Cap ${id}` });
    const body = await resolved([...hundred, "Unknown", "", " "].join(","));
    expect(body).toEqual(hundred.map((id) => storedJson(id, `Cap ${id}`)));
    expect(lookups()).toHaveLength(before);
  });

  test("answers nothing, asking no one, when only blanks and Unknown are left", async () => {
    const before = lookups().length;
    for (const ids of ["Unknown", ",,,", " , Unknown ,", "Unknown,Unknown"]) {
      const result = await get(ids);
      expect([ids, result.json]).toEqual([ids, { status: "success", body: [] }]);
    }
    expect(lookups()).toHaveLength(before);
  });
});

describe("stored institutions", () => {
  test("are answered from the table, trimmed and deduplicated, without asking Plaid", async () => {
    await seedInstitution(stack, "ins_stored_a", { name: "Stored A", raw: { institution_id: "ins_stored_a", name: "Stored A", url: "https://a.example.com", oauth: true } });
    await seedInstitution(stack, "ins_stored_b", { name: null, raw: null });
    const before = lookups().length;
    const body = await resolved(" ins_stored_a , ins_stored_b,ins_stored_a,,Unknown");
    expect(body).toEqual([storedJson("ins_stored_a", "Stored A"), storedJson("ins_stored_b", null)]);
    expect(lookups()).toHaveLength(before);
  });
});

describe("the Plaid fallback", () => {
  test("resolves an id that is not stored, answers it beside the stored ones, and stores it for next time", async () => {
    await seedInstitution(stack, "ins_known_1", { name: "Known One" });
    const plaid = stack.upstream.plaid.addInstitution("ins_new_1", { name: "New One", logo: "iVBORw0KGgo=", status: { item_logins: { status: "HEALTHY" } } });
    const before = lookups().length;

    const body = await resolved("ins_known_1,ins_new_1");
    expect(body).toEqual([storedJson("ins_known_1", "Known One"), fetchedJson(plaid)]);
    expect(lookups().slice(before)).toEqual([
      {
        host: PLAID_PRODUCTION_HOST,
        path: "/institutions/get_by_id",
        body: { institution_id: "ins_new_1", country_codes: ["US"] },
        headers: expect.objectContaining(PLAID_HEADERS),
      },
    ]);

    const row = await stack.waitFor(() => rowOf(stack, "institutions", "ins_new_1"), { what: "the resolved institution to be stored" });
    expect(row).toEqual({ institution_id: "ins_new_1", name: "New One", raw: fetchedJson(plaid), updated: expect.any(String) });

    // Now it is stored: answered from the table, in the stored shape, without Plaid.
    const again = await resolved("ins_new_1,ins_known_1");
    expect(again).toEqual([storedJson("ins_known_1", "Known One"), storedJson("ins_new_1", "New One")]);
    expect(lookups()).toHaveLength(before + 1);
  });

  test("answers only the fields Plaid sent, and asks once for an id repeated in the request", async () => {
    stack.upstream.hub.on(PLAID_PRODUCTION_HOST, (request) => {
      if (request.path !== "/institutions/get_by_id" || (request.json as { institution_id?: string })?.institution_id !== "ins_sparse") return undefined;
      return new Response(JSON.stringify({ institution: { institution_id: "ins_sparse", name: "Sparse", oauth: true, extra: 1 }, request_id: "r" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const before = lookups().length;
    expect(await resolved("ins_sparse,ins_sparse, ins_sparse")).toEqual([{ institution_id: "ins_sparse", name: "Sparse", oauth: true }]);
    expect(lookedUp(before)).toEqual(["ins_sparse"]);
    const row = await stack.waitFor(() => rowOf(stack, "institutions", "ins_sparse"), { what: "the sparse institution to be stored" });
    expect(row?.raw).toEqual({ institution_id: "ins_sparse", name: "Sparse", oauth: true });
  });

  test("leaves out an id Plaid can't resolve, and answers its siblings whole", async () => {
    await seedInstitution(stack, "ins_known_2", { name: "Known Two" });
    const plaid = stack.upstream.plaid.addInstitution("ins_new_2");
    const before = lookups().length;
    const body = await resolved("ins_known_2,ins_new_2,ins_unresolvable");
    expect(body).toEqual([storedJson("ins_known_2", "Known Two"), fetchedJson(plaid)]);
    expect([...lookedUp(before)].sort()).toEqual(["ins_new_2", "ins_unresolvable"]);
    await stack.waitForLog('Failed to get institution data {"institutionId":"ins_unresolvable"}');
    await stack.waitFor(() => rowOf(stack, "institutions", "ins_new_2"), { what: "the resolved institution to be stored" });
    expect(await rowOf(stack, "institutions", "ins_unresolvable")).toBeUndefined();
  });

  test("leaves out an id whose lookup fails in any way, and stores nothing for it", async () => {
    await seedInstitution(stack, "ins_known_3", { name: "Known Three" });
    const failures: [string, () => void][] = [
      ["ins_fail_error", () => stack.upstream.plaid.fail("/institutions/get_by_id", { error_code: "INTERNAL_SERVER_ERROR" }, { times: 1 })],
      ["ins_fail_rate", () => stack.upstream.plaid.fail("/institutions/get_by_id", { error_code: "RATE_LIMIT_EXCEEDED" }, { times: 1 })],
      ["ins_fail_html", () => stack.upstream.plaid.fail("/institutions/get_by_id", { status: 502, body: "<html>Bad Gateway</html>", contentType: "text/html" }, { times: 1 })],
      ["ins_fail_empty", () => stack.upstream.plaid.fail("/institutions/get_by_id", { status: 200, body: "{}", contentType: "application/json" }, { times: 1 })],
      ["ins_fail_text", () => stack.upstream.plaid.fail("/institutions/get_by_id", { status: 200, body: "not json" }, { times: 1 })],
      ["ins_fail_null", () => stack.upstream.plaid.fail("/institutions/get_by_id", { status: 200, body: '{"institution":null}', contentType: "application/json" }, { times: 1 })],
    ];
    for (const [id, script] of failures) {
      stack.upstream.plaid.addInstitution(id);
      script();
      const before = lookups().length;
      expect([id, await resolved(`ins_known_3,${id}`)]).toEqual([id, [storedJson("ins_known_3", "Known Three")]]);
      expect(lookedUp(before)).toEqual([id]);
      await stack.waitForLog(`Failed to get institution data {"institutionId":"${id}"}`);
      expect(await rowOf(stack, "institutions", id)).toBeUndefined();
    }
  });

  test("goes to the sandbox, with the sandbox secret, for the demo user", async () => {
    const demo = await stack.login("demo");
    const plaid = stack.upstream.plaid.addInstitution("ins_demo");
    const before = lookups().length;
    expect(await resolved("ins_demo", demo)).toEqual([fetchedJson(plaid)]);
    expect(lookups().slice(before)).toEqual([
      {
        host: PLAID_SANDBOX_HOST,
        path: "/institutions/get_by_id",
        body: { institution_id: "ins_demo", country_codes: ["US"] },
        headers: expect.objectContaining({ ...PLAID_HEADERS, "plaid-secret": "conformance-plaid-sandbox" }),
      },
    ]);
  });
});

describe("the per-user fallback budget", () => {
  test("charges one slot per Plaid lookup, failed or not, and past twenty a minute answers what is stored", async () => {
    const { client, user_id } = await freshUser("institutions-budget");
    await seedInstitution(stack, "ins_budget_stored", { name: "Budget Stored" });
    const before = lookups().length;
    // Twenty lookups, one per request, every other one unresolvable: each costs a slot.
    for (let i = 0; i < 20; i++) {
      const id = `ins_budget_${String(i).padStart(2, "0")}`;
      if (i % 2 === 0) stack.upstream.plaid.addInstitution(id);
      const body = await resolved(id, client);
      expect(body.map((institution) => institution.institution_id)).toEqual(i % 2 === 0 ? [id] : []);
    }
    expect(lookups()).toHaveLength(before + 20);

    // The budget is spent: missing ids are left out, stored ones still answered.
    stack.upstream.plaid.addInstitution("ins_budget_over");
    expect(await resolved("ins_budget_stored,ins_budget_over,ins_budget_over_2", client)).toEqual([storedJson("ins_budget_stored", "Budget Stored")]);
    await stack.waitForLog(`Institution Plaid-fallback capped by the per-user rate limit {"userId":"${user_id}","missing":2,"allowed":0}`);
    expect(await resolved("ins_budget_over", client)).toEqual([]);
    // Stored ids cost nothing, so they are answered whatever the budget says.
    expect(await resolved("ins_budget_stored", client)).toEqual([storedJson("ins_budget_stored", "Budget Stored")]);
    expect(lookups()).toHaveLength(before + 20);

    // Another user has a budget of their own.
    const other = await freshUser("institutions-budget-other");
    expect(await resolved("ins_budget_over", other.client)).toEqual([fetchedJson(stack.upstream.plaid.institutions.get("ins_budget_over")!)]);
    expect(lookedUp(before + 20)).toEqual(["ins_budget_over"]);
  });

  test("with fewer slots left than missing ids, looks up the first ones and leaves out the rest", async () => {
    const { client, user_id } = await freshUser("institutions-budget-partial");
    const before = lookups().length;
    for (let i = 0; i < 19; i++) await resolved(`ins_partial_spend_${i}`, client);
    expect(lookups()).toHaveLength(before + 19);

    const plaid = stack.upstream.plaid.addInstitution("ins_partial_a");
    stack.upstream.plaid.addInstitution("ins_partial_b");
    expect(await resolved("ins_partial_a,ins_partial_b,ins_partial_c", client)).toEqual([fetchedJson(plaid)]);
    expect(lookedUp(before + 19)).toEqual(["ins_partial_a"]);
    await stack.waitForLog(`Institution Plaid-fallback capped by the per-user rate limit {"userId":"${user_id}","missing":3,"allowed":1}`);
  });
});

describe("without Plaid configured", () => {
  let bare: Stack;
  beforeAll(async () => {
    bare = await startStack({ env: { PLAID_CLIENT_ID: undefined } });
  });
  afterAll(() => bare.stop());

  test("answers what is stored and asks no one about the rest", async () => {
    await seedInstitution(bare, "ins_bare_stored", { name: "Bare Stored" });
    bare.upstream.plaid.addInstitution("ins_bare_missing");
    const client = await bare.login();
    const result = await client.get<Institution[]>("/institutions", { query: { ids: "ins_bare_stored,ins_bare_missing" } });
    expect(result.json).toEqual({ status: "success", body: [storedJson("ins_bare_stored", "Bare Stored")] });
    expect(bare.upstream.plaid.seen()).toEqual([]);
    expect(await rowsOf(bare, "institutions")).toHaveLength(1);
    await bare.waitForLog("Plaid is not configured. Check env vars.");
  });
});
