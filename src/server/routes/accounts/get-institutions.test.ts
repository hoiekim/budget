// Route coverage for `GET /api/institutions?ids=<csv>`. Pins: (1) SQL layer
// uses one IN query, not N per-id lookups; (2) Plaid-fallback fires for
// misses only; (3) empty / "Unknown" filter (the sentinel a fresh manual
// account carries) short-circuits; (4) dedupe protects the SQL layer even
// without the FE dedupe; (5) a Plaid failure omits its own id rather than
// failing the batch.

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg, mockQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

// Plaid is the leaf the fallback path reaches. Spread the real module rather
// than replacing it — every model in the graph imports enums from here — and
// override only the client class the fallback constructs. `mock.module` is
// process-global, so the real module goes back in `afterAll`.
const REAL_PLAID = await import("plaid");

const plaidCalls: string[] = [];
const unresolvableIds = new Set<string>();
let inflight = 0;
let peakInflight = 0;

class FakePlaidApi {
  async institutionsGetById({ institution_id }: { institution_id: string }) {
    plaidCalls.push(institution_id);
    inflight++;
    peakInflight = Math.max(peakInflight, inflight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (unresolvableIds.has(institution_id)) {
        throw new Error(`Plaid has no institution ${institution_id}`);
      }
      return {
        data: {
          institution: {
            institution_id,
            name: `Plaid ${institution_id}`,
            products: [],
            country_codes: [],
            url: null,
            primary_color: null,
            logo: null,
            routing_numbers: [],
            oauth: false,
            status: null,
          },
        },
      };
    } finally {
      inflight--;
    }
  }
}

const fakePlaid = { ...REAL_PLAID, PlaidApi: FakePlaidApi };
mock.module("plaid", () => ({ ...fakePlaid, default: fakePlaid }));

const { getInstitutionsRoute } = await import("./get-institutions");
const { institutionFallbackRateLimiter } = await import("server/lib/rate-limit");
const { getInstitutionsByIds } = await import("server/lib/plaid/institutions");

const USER_ID = "u-1";

const plaidUser = { user_id: USER_ID, username: "test" } as Parameters<
  typeof getInstitutionsByIds
>[0];

/**
 * The upsert of a fetched institution is deliberately off the response's
 * latency path, so it can still be in flight when the route returns and would
 * otherwise land in the next test's query log.
 */
const drainDeferredWrites = () => new Promise((resolve) => setTimeout(resolve, 25));

afterAll(() => {
  mock.module("plaid", () => REAL_PLAID);
  restoreLeaves();
});

beforeEach(() => {
  resetQueryMocks();
  plaidCalls.length = 0;
  unresolvableIds.clear();
  inflight = 0;
  peakInflight = 0;
  institutionFallbackRateLimiter.reset(USER_ID);
});

function makeReq(query: Record<string, string> = {}, userId: string | null = USER_ID) {
  return {
    method: "GET",
    path: "/institutions",
    url: "http://x/api/institutions?" + new URLSearchParams(query).toString(),
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "test" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof getInstitutionsRoute.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof getInstitutionsRoute.execute>[1];

const makeInstRow = (id: string) => ({
  institution_id: id,
  name: `Bank ${id}`,
  products: null,
  country_codes: null,
  url: null,
  primary_color: null,
  logo: null,
  routing_numbers: null,
  raw: null,
  updated: "2026-08-17T00:00:00Z",
});

describe("get-institutions route", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getInstitutionsRoute.execute(makeReq({ ids: "ins_5" }, null), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing ids param", async () => {
    const result = await getInstitutionsRoute.execute(makeReq({}), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/ids/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("empty ids CSV is rejected — `requireQueryString` treats it as missing", async () => {
    const result = await getInstitutionsRoute.execute(makeReq({ ids: "" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("only-`Unknown` sentinel filters to empty — no DB hit", async () => {
    // "Unknown" is the sentinel a manual account's institution_id carries
    // (`sync.ts:400` skips it in the old fan-out too). After filter → empty
    // set → short-circuit before the repo call.
    const result = await getInstitutionsRoute.execute(makeReq({ ids: "Unknown,Unknown" }), fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("all-hits path: one IN query — the N+1 collapse this route exists for", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeInstRow("ins_5"), makeInstRow("ins_56"), makeInstRow("ins_127991")],
      rowCount: 3,
    });
    const result = await getInstitutionsRoute.execute(
      makeReq({ ids: "ins_5,ins_56,ins_127991" }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect((result?.body as { institution_id: string }[]).map((i) => i.institution_id).sort()).toEqual([
      "ins_127991",
      "ins_5",
      "ins_56",
    ]);
    // The property this route exists to pin: one SQL query, not N.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/\bIN\s*\(/i);
    expect(values).toEqual(expect.arrayContaining(["ins_5", "ins_56", "ins_127991"]));
  });

  test("dedupes at the repo boundary even if the caller passes duplicates", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeInstRow("ins_5")], rowCount: 1 });
    await getInstitutionsRoute.execute(
      makeReq({ ids: "ins_5,ins_5,ins_5" }),
      fakeRes(),
    );
    const [, values] = mockQuery.mock.calls[0];
    const ins5Count = (values as unknown[]).filter((v) => v === "ins_5").length;
    expect(ins5Count).toBe(1);
  });

  test("trims whitespace around each id — CSVs from URL params can end up padded", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeInstRow("ins_5")], rowCount: 1 });
    await getInstitutionsRoute.execute(makeReq({ ids: " ins_5 , ins_5" }), fakeRes());
    const [, values] = mockQuery.mock.calls[0];
    // Post-trim + dedupe → exactly one "ins_5" in the IN clause.
    const ins5Count = (values as unknown[]).filter((v) => v === "ins_5").length;
    expect(ins5Count).toBe(1);
  });
});

describe("get-institutions Plaid-fallback bounds", () => {
  const makeIds = (n: number, prefix = "ins_miss_") =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  test("rejects a CSV carrying more ids than the per-request cap", async () => {
    const result = await getInstitutionsRoute.execute(
      makeReq({ ids: makeIds(101).join(",") }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/at most 100/i);
    // Rejected before the SQL layer and before Plaid — the point of the cap is
    // that an oversized list costs nothing downstream.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(plaidCalls).toEqual([]);
  });

  test("accepts a CSV at exactly the cap", async () => {
    const ids = makeIds(100, "ins_hit_");
    mockQuery.mockResolvedValueOnce({
      rows: ids.map(makeInstRow),
      rowCount: ids.length,
    });
    const result = await getInstitutionsRoute.execute(makeReq({ ids: ids.join(",") }), fakeRes());
    expect(result?.status).toBe("success");
    expect((result?.body as unknown[]).length).toBe(100);
    expect(plaidCalls).toEqual([]);
  });

  test("holds the Plaid fan-out to four round trips in flight", async () => {
    const ids = makeIds(20);
    const result = await getInstitutionsRoute.execute(makeReq({ ids: ids.join(",") }), fakeRes());
    expect(result?.status).toBe("success");
    expect(plaidCalls.length).toBe(20);
    expect(peakInflight).toBe(4);
    await drainDeferredWrites();
  });

  test("persists the fan-out's rows in one DB round trip, not one per row", async () => {
    const ids = makeIds(20);
    await getInstitutionsRoute.execute(makeReq({ ids: ids.join(",") }), fakeRes());
    await drainDeferredWrites();
    // One batched IN lookup plus one batched upsert. Upserting per fetched row
    // makes this 21.
    expect(mockQuery.mock.calls.length).toBe(2);
  });

  test("charges one slot per Plaid round trip and stops at the per-user cap", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeInstRow("ins_stored")], rowCount: 1 });
    const first = await getInstitutionsRoute.execute(
      makeReq({ ids: ["ins_stored", ...makeIds(25)].join(",") }),
      fakeRes(),
    );
    expect(first?.status).toBe("success");
    expect(plaidCalls.length).toBe(20);
    // The stored row is still served, plus the 20 the budget paid for.
    expect((first?.body as unknown[]).length).toBe(21);
    expect(institutionFallbackRateLimiter.remaining(USER_ID)).toBe(0);
    await drainDeferredWrites();

    plaidCalls.length = 0;
    resetQueryMocks();
    mockQuery.mockResolvedValueOnce({ rows: [makeInstRow("ins_stored")], rowCount: 1 });
    const second = await getInstitutionsRoute.execute(
      makeReq({ ids: ["ins_stored", ...makeIds(5, "ins_other_")].join(",") }),
      fakeRes(),
    );
    // Exhausted budget degrades to the stored rows rather than shedding the
    // whole request — the caller keeps the institutions it already had.
    expect(plaidCalls).toEqual([]);
    expect(second?.status).toBe("success");
    expect(
      (second?.body as { institution_id: string }[]).map((i) => i.institution_id),
    ).toEqual(["ins_stored"]);
  });

  test("an id already in the table never charges the limiter", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeInstRow("ins_5"), makeInstRow("ins_56")],
      rowCount: 2,
    });
    await getInstitutionsRoute.execute(makeReq({ ids: "ins_5,ins_56" }), fakeRes());
    expect(plaidCalls).toEqual([]);
    expect(institutionFallbackRateLimiter.remaining(USER_ID)).toBe(20);
  });

  test("a repeated unresolvable id costs one round trip, not one per copy", async () => {
    const repeated = Array.from({ length: 30 }, () => "ins_bogus").join(",");
    const result = await getInstitutionsRoute.execute(makeReq({ ids: repeated }), fakeRes());
    expect(result?.status).toBe("success");
    expect(plaidCalls).toEqual(["ins_bogus"]);
    expect(institutionFallbackRateLimiter.remaining(USER_ID)).toBe(19);
    await drainDeferredWrites();
  });

  test("resolved institutions are returned alongside the stored rows", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeInstRow("ins_5")], rowCount: 1 });
    const result = await getInstitutionsRoute.execute(
      makeReq({ ids: "ins_5,ins_fresh" }),
      fakeRes(),
    );
    const byId = (result?.body as { institution_id: string; name: string }[]).reduce(
      (acc, i) => ({ ...acc, [i.institution_id]: i.name }),
      {} as Record<string, string>,
    );
    expect(byId["ins_5"]).toBe("Bank ins_5");
    expect(byId["ins_fresh"]).toBe("Plaid ins_fresh");
    await drainDeferredWrites();
  });
});

// The partial-failure guarantee both `getInstitutionsByIds` and this route
// document: an id Plaid cannot resolve drops out of the result instead of
// failing the batch, so one dead institution does not blank every other
// institution's logo and name on the same render pass. Every case here fails
// if the `catch` in `getInstitution` rethrows or its `.filter()` is dropped.
describe("get-institutions partial Plaid failure", () => {
  test("one unresolvable id drops out and its siblings come back whole", async () => {
    unresolvableIds.add("ins_dead");

    const fetched = await getInstitutionsByIds(plaidUser, [
      "ins_live_a",
      "ins_dead",
      "ins_live_b",
    ]);

    // Contents, not length: a length check passes when the wrong element was
    // dropped, and reading `name` proves the survivor is the full institution
    // rather than a null-field placeholder standing in for the failure.
    expect(fetched.map((i) => [i?.institution_id, i?.name])).toEqual([
      ["ins_live_a", "Plaid ins_live_a"],
      ["ins_live_b", "Plaid ins_live_b"],
    ]);
    // The failure did not cancel its siblings' round trips.
    expect(plaidCalls.sort()).toEqual(["ins_dead", "ins_live_a", "ins_live_b"]);
  });

  test("every id failing resolves to an empty array rather than rejecting", async () => {
    unresolvableIds.add("ins_dead_a");
    unresolvableIds.add("ins_dead_b");

    // The vacuous case an `every(...)` over the survivors would pass on.
    // `toStrictEqual`, not `toEqual`: bun reads `[undefined, undefined]` as
    // equal to `[]`, so the loose matcher passes on an unfiltered result.
    expect(await getInstitutionsByIds(plaidUser, ["ins_dead_a", "ins_dead_b"])).toStrictEqual([]);
  });

  test("the route serves the stored rows and the resolvable misses around a failure", async () => {
    unresolvableIds.add("ins_dead");
    mockQuery.mockResolvedValueOnce({ rows: [makeInstRow("ins_5")], rowCount: 1 });

    const result = await getInstitutionsRoute.execute(
      makeReq({ ids: "ins_5,ins_live,ins_dead" }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(
      (result?.body as { institution_id: string; name: string }[]).map((i) => [
        i?.institution_id,
        i?.name,
      ]),
    ).toEqual([
      ["ins_5", "Bank ins_5"],
      ["ins_live", "Plaid ins_live"],
    ]);
    await drainDeferredWrites();
  });

  test("a failure still charges its slot, so the limiter cannot be drained for free", async () => {
    unresolvableIds.add("ins_dead");
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await getInstitutionsRoute.execute(makeReq({ ids: "ins_dead,ins_live" }), fakeRes());

    expect(institutionFallbackRateLimiter.remaining(USER_ID)).toBe(18);
    await drainDeferredWrites();
  });
});
