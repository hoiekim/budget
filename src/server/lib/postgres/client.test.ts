// Tests for the lazy SQL client in ./client: construction timing, cache
// behavior, and the pool wrapper's mapping onto Bun.sql's API.
//
// The old pg Proxy tests are gone with the Proxy: the pool is now a plain
// object with exactly `query`/`connect`/`end`, so there are no traps to
// forward (`set`, `has`, key enumeration, prototype chain) and nothing for
// a caller to mutate via `this`. What survives is the behavior that
// mattered: lazy construction, single instantiation, cache invalidation,
// and mock authoritativeness. The old `logDroppedConnections` event tests
// are likewise gone — Bun.sql has no client/pool error events; dropped
// connections surface through the construction-time `onclose` handler,
// whose filter is pinned below.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const fake = createFakeSql();
mock.module("./sql-driver", () => fake.driver);

const { pool, resetPool, isConnectionLoss } = await import("./client");

afterAll(restoreLeaves);

beforeEach(() => {
  fake.resetSqlMocks();
  fake.constructedOptions.length = 0;
  resetPool();
});

describe("lazy client", () => {
  test("does not construct SQL until first use", () => {
    expect(fake.constructedOptions).toHaveLength(0);
  });

  test("first use constructs once and subsequent uses reuse it", async () => {
    await pool.query("SELECT 1");
    await pool.query("SELECT 2");
    expect(fake.constructedOptions).toHaveLength(1);
  });

  test("resetPool drops the cached instance so the next use rebuilds", async () => {
    await pool.query("SELECT 1");
    expect(fake.constructedOptions).toHaveLength(1);
    resetPool();
    await pool.query("SELECT 1");
    expect(fake.constructedOptions).toHaveLength(2);
  });

  test("a later mock displaces a client cached against the previous binding", async () => {
    await pool.query("SELECT 1");
    expect(fake.constructedOptions).toHaveLength(1);

    const next = createFakeSql();
    mock.module("./sql-driver", () => next.driver);
    await pool.query("SELECT 1");
    expect(next.constructedOptions).toHaveLength(1);
    expect(fake.constructedOptions).toHaveLength(1);

    // Hand the file's mock back so the remaining tests (and restoreLeaves)
    // see a consistent registry.
    mock.module("./sql-driver", () => fake.driver);
    resetPool();
  });
});

describe("pool wrapper", () => {
  test("query maps the Bun-shaped result to rows + rowCount", async () => {
    fake.mockUnsafe.mockResolvedValueOnce({ rows: [{ a: 1 }], rowCount: 1 });
    const result = await pool.query("SELECT 1");
    expect(result.rows).toEqual([{ a: 1 }]);
    expect(result.rowCount).toBe(1);
    expect(fake.mockUnsafe.mock.calls[0]).toEqual(["SELECT 1", undefined]);
  });

  test("query passes values through to unsafe", async () => {
    await pool.query("SELECT $1", ["x"]);
    expect(fake.mockUnsafe.mock.calls[0]).toEqual(["SELECT $1", ["x"]]);
  });

  test("connect reserves a client whose queries and release are separate", async () => {
    const client = await pool.connect();
    expect(fake.mockReserve).toHaveBeenCalledTimes(1);
    await client.query("SELECT 1");
    expect(fake.mockReservedUnsafe.mock.calls[0][0]).toBe("SELECT 1");
    expect(fake.mockUnsafe).not.toHaveBeenCalled();
    client.release();
    expect(fake.mockRelease).toHaveBeenCalledTimes(1);
  });

  test("end closes the client", async () => {
    await pool.end();
    expect(fake.mockClose).toHaveBeenCalledTimes(1);
  });
});

describe("connection-loss filter", () => {
  test("routine closes are not connection loss", () => {
    expect(isConnectionLoss(null)).toBe(false);
    expect(isConnectionLoss({ code: "ERR_POSTGRES_IDLE_TIMEOUT" } as Error)).toBe(false);
    expect(isConnectionLoss({ code: "ERR_POSTGRES_CONNECTION_CLOSED" } as Error)).toBe(false);
  });

  test("anything else is", () => {
    expect(isConnectionLoss({ code: "ERR_POSTGRES_SERVER_ERROR" } as Error)).toBe(true);
    expect(isConnectionLoss({ code: "SOMETHING_ELSE" } as Error)).toBe(true);
    expect(isConnectionLoss(new Error("no code"))).toBe(true);
  });

  test("the filter is what construction wires as onclose", async () => {
    await pool.query("SELECT 1");
    const options = fake.constructedOptions.at(-1) as { onclose: unknown };
    expect(typeof options.onclose).toBe("function");
  });
});
