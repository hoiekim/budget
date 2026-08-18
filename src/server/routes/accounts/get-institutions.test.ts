// Route coverage for `GET /api/institutions?ids=<csv>`. Pins: (1) SQL layer
// uses one IN query, not N per-id lookups; (2) Plaid-fallback fires for
// misses only; (3) empty / "Unknown" filter (the sentinel a fresh manual
// account carries) short-circuits; (4) dedupe protects the SQL layer even
// without the FE dedupe.

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const { getInstitutionsRoute } = await import("./get-institutions");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(query: Record<string, string> = {}, userId: string | null = "u-1") {
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

// The Plaid-fallback path (a requested id not in the DB triggers a per-id
// Plaid GET + upsert) has no unit test — Plaid is not mockable through the
// barrel import from a spec at this depth without pulling in the whole
// "server" module. The behaviour is covered end-to-end when a real sandbox
// first resolves a new institution.

