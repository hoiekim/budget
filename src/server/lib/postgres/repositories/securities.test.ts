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

const { remapSecurityReferences } = await import("./securities");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockClear();
});

interface Call {
  sql: string;
  values?: unknown[];
}

const capturedCalls = (): Call[] =>
  mockQuery.mock.calls.map((c) => ({ sql: (c as [string, unknown[]?])[0], values: (c as [string, unknown[]?])[1] }));

describe("remapSecurityReferences (#598 — Plaid becomes source of truth)", () => {
  test("no-op when oldSecurityId === newSecurityId", async () => {
    await remapSecurityReferences("sec-a", "sec-a");
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  test("wraps five updates + one delete in a BEGIN…COMMIT transaction", async () => {
    await remapSecurityReferences("manual-voo", "plaid-voo");
    const calls = capturedCalls();
    const sqls = calls.map((c) => c.sql.trim());

    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");

    // Body: 4 UPDATEs + 1 DELETE, all pointing new_id → old_id.
    const body = sqls.slice(1, -1);
    expect(body).toHaveLength(5);
    expect(body.some((s) => /UPDATE investment_transactions SET security_id/.test(s))).toBe(true);
    expect(body.some((s) => /UPDATE holdings SET security_id/.test(s))).toBe(true);
    expect(body.some((s) => /UPDATE snapshots SET security_id/.test(s))).toBe(true);
    expect(body.some((s) => /UPDATE snapshots SET holding_security_id/.test(s))).toBe(true);
    expect(body.some((s) => /DELETE FROM securities WHERE security_id/.test(s))).toBe(true);
  });

  test("every UPDATE + DELETE binds [newSecurityId, oldSecurityId] in that order", async () => {
    await remapSecurityReferences("manual-voo", "plaid-voo");
    const body = capturedCalls().slice(1, -1); // strip BEGIN/COMMIT

    // The 4 UPDATEs bind ($1 = newId, $2 = oldId).
    const updates = body.filter((c) => /^UPDATE /.test(c.sql.trim()));
    expect(updates).toHaveLength(4);
    for (const u of updates) {
      expect(u.values).toEqual(["plaid-voo", "manual-voo"]);
    }

    // DELETE binds only oldId.
    const del = body.find((c) => /^DELETE /.test(c.sql.trim()));
    expect(del?.values).toEqual(["manual-voo"]);
  });

  test("touches BOTH snapshot foreign keys — security_id (security-type snap) and holding_security_id (holding-type snap)", async () => {
    // The `snapshots` table is polymorphic. A holding-type row carries
    // its security link on `holding_security_id`; a security-type row
    // carries it on `security_id`. Missing either update would orphan
    // one snapshot flavor after the securities row is deleted.
    await remapSecurityReferences("manual-voo", "plaid-voo");
    const body = capturedCalls().slice(1, -1);
    const snapUpdates = body.filter((c) =>
      /UPDATE snapshots SET (security_id|holding_security_id)/.test(c.sql),
    );
    expect(snapUpdates).toHaveLength(2);
  });

  test("closes #598 direction — remap runs BEFORE the DELETE (a mid-run failure would leave the shared securities row intact rather than orphaning references)", async () => {
    await remapSecurityReferences("manual-voo", "plaid-voo");
    const body = capturedCalls().slice(1, -1);
    const deleteIndex = body.findIndex((c) => /^DELETE /.test(c.sql.trim()));
    // Every UPDATE lives at a lower index than the DELETE.
    const updateIndices = body
      .map((c, i) => ({ i, sql: c.sql.trim() }))
      .filter(({ sql }) => /^UPDATE /.test(sql))
      .map(({ i }) => i);
    for (const idx of updateIndices) {
      expect(idx).toBeLessThan(deleteIndex);
    }
  });
});
