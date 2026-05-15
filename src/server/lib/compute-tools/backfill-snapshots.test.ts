/**
 * Tests for backfillMonthlySecuritySnapshotsForward — covers the forward-only
 * monthly fill semantics, cash-equivalent skipping, polygon error handling,
 * and the maxMonthsPerInvocation cap.
 *
 * NOTE on mocking: we deliberately avoid `mock.module(…)` here. That mock
 * is process-wide in Bun and leaks into sibling test files (`snapshots`
 * repo, cron tests, etc.). `backfillMonthlySecuritySnapshotsForward`
 * accepts DI seams as positional options, so we pass plain mock fns and
 * the cross-file isolation problem disappears.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

import { backfillMonthlySecuritySnapshotsForward } from "./backfill-snapshots";

const mockGetSecuritySnapshots = mock(async (_opts: { security_id?: string }) => [] as Array<{
  snapshot_id: string;
  snapshot_date: string;
  security_id: string;
  close_price?: number;
}>);
const mockUpsertSnapshots = mock(async (_snapshots: unknown[]) => [] as unknown[]);
const mockSearchSecuritiesById = mock(
  async (_ids: string[]) => [] as Array<{ security_id: string; ticker_symbol: string | null; type: string | null }>,
);
const mockGetClosePrice = mock(
  async (_ticker: string, _date: Date) =>
    ({ success: true, data: 100 } as { success: true; data: number } | { success: false; error: string; message: string }),
);

/**
 * Bundle the DI seams into a single options object every test passes
 * through. The `as never` casts dodge over-strict variance in the
 * real-fn type signatures — the production callers don't constrain the
 * return type any tighter than the mocks already provide.
 */
type BackfillOptions = NonNullable<Parameters<typeof backfillMonthlySecuritySnapshotsForward>[1]>;
const di = (): BackfillOptions => ({
  getSecuritySnapshots: mockGetSecuritySnapshots as unknown as BackfillOptions["getSecuritySnapshots"],
  upsertSnapshots: mockUpsertSnapshots as unknown as BackfillOptions["upsertSnapshots"],
  searchSecuritiesById:
    mockSearchSecuritiesById as unknown as BackfillOptions["searchSecuritiesById"],
  getClosePrice: mockGetClosePrice as unknown as BackfillOptions["getClosePrice"],
});

beforeEach(() => {
  mockGetSecuritySnapshots.mockReset();
  mockUpsertSnapshots.mockReset();
  mockSearchSecuritiesById.mockReset();
  mockGetClosePrice.mockReset();

  // Sensible defaults: empty existing snapshots, polygon returns price=100.
  mockGetSecuritySnapshots.mockImplementation(async () => []);
  mockUpsertSnapshots.mockImplementation(async () => []);
  mockGetClosePrice.mockImplementation(async () => ({ success: true, data: 100 }));
});

describe("backfillMonthlySecuritySnapshotsForward", () => {
  test("returns zero counts on empty refs", async () => {
    const result = await backfillMonthlySecuritySnapshotsForward([], di());
    expect(result).toEqual({ filled: 0, skipped: 0, empty: 0, errors: 0 });
    expect(mockSearchSecuritiesById).toHaveBeenCalledTimes(0);
  });

  test("fills monthly snapshots from fromDate forward to current month", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);

    // fromDate ~3 months before "now" so we get a meaningful loop.
    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth() - 3, 15).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate }],
      di(),
    );

    // 4 months in range (fromMonth, +1, +2, +3=current). All filled.
    expect(result.filled).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(mockGetClosePrice).toHaveBeenCalledTimes(4);
    expect(mockUpsertSnapshots).toHaveBeenCalledTimes(1);
    expect(mockUpsertSnapshots.mock.calls[0][0]).toHaveLength(4);
  });

  test("skips months that already have a snapshot", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);

    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    mockGetSecuritySnapshots.mockImplementation(async () => [
      {
        snapshot_id: "existing",
        snapshot_date: lastMonth.toISOString().slice(0, 10),
        security_id: "sec-aapl",
        close_price: 90,
      },
    ]);

    const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate }],
      di(),
    );

    // 2 months (last + current). Last is skipped, current is filled.
    expect(result.filled).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mockGetClosePrice).toHaveBeenCalledTimes(1);
  });

  test("skips cash-type securities entirely", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-cash", ticker_symbol: "CUR:USD", type: "cash" },
    ]);

    const fromDate = new Date(new Date().getFullYear() - 1, 0, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-cash", fromDate }],
      di(),
    );

    expect(result.filled).toBe(0);
    expect(mockGetClosePrice).toHaveBeenCalledTimes(0);
    expect(mockGetSecuritySnapshots).toHaveBeenCalledTimes(0);
  });

  test("skips securities whose ticker starts with CUR: regardless of type", async () => {
    // Defensive: some Plaid items report cash with no `type` set but a `CUR:` ticker.
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-eur", ticker_symbol: "CUR:EUR", type: null },
    ]);
    const fromDate = new Date(new Date().getFullYear(), 0, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-eur", fromDate }],
      di(),
    );

    expect(result.filled).toBe(0);
    expect(mockGetClosePrice).toHaveBeenCalledTimes(0);
  });

  test("does NOT reach into months before fromDate (forward-only)", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);

    // fromDate = current month → only the current month should fire.
    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate }],
      di(),
    );

    expect(result.filled).toBe(1);
    expect(mockGetClosePrice).toHaveBeenCalledTimes(1);
  });

  test("uses yesterday's date for current-month snapshot (today hasn't closed yet)", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate }],
      di(),
    );

    // The single polygon call for the current month should target yesterday,
    // not today — today's market hasn't closed.
    expect(mockGetClosePrice).toHaveBeenCalledTimes(1);
    const passedDate = mockGetClosePrice.mock.calls[0][1] as Date;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(passedDate.toISOString().slice(0, 10)).toBe(yesterday.toISOString().slice(0, 10));
  });

  test("does NOT call polygon when fromDate is in the future", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);

    const now = new Date();
    const future = new Date(now.getFullYear() + 1, 5, 15).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate: future }],
      di(),
    );

    expect(result.filled).toBe(0);
    expect(mockGetClosePrice).toHaveBeenCalledTimes(0);
  });

  test("counts polygon no_data without aborting other months", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);

    let callCount = 0;
    mockGetClosePrice.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: false, error: "no_data", message: "delisted" };
      return { success: true, data: 100 };
    });

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate }],
      di(),
    );

    expect(result.empty).toBe(1);
    expect(result.filled).toBe(1);
    expect(result.errors).toBe(0);
  });

  test("counts polygon api_error in the errors bucket", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);
    mockGetClosePrice.mockImplementation(async () => ({
      success: false,
      error: "api_error",
      message: "boom",
    }));

    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate }],
      di(),
    );

    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.filled).toBe(0);
  });

  test("respects maxMonthsPerInvocation cap", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => [
      { security_id: "sec-aapl", ticker_symbol: "AAPL", type: "equity" },
    ]);

    // 24 months before now — without a cap that'd be 25 polygon calls.
    const now = new Date();
    const fromDate = new Date(now.getFullYear() - 2, now.getMonth(), 1).toISOString();

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-aapl", fromDate }],
      { maxMonthsPerInvocation: 5, ...di() },
    );

    expect(mockGetClosePrice).toHaveBeenCalledTimes(5);
    expect(result.filled).toBe(5);
  });

  test("skips securities with no row in the securities table", async () => {
    mockSearchSecuritiesById.mockImplementation(async () => []); // empty result

    const result = await backfillMonthlySecuritySnapshotsForward(
      [{ security_id: "sec-orphan", fromDate: new Date().toISOString() }],
      di(),
    );

    expect(result.filled).toBe(0);
    expect(mockGetClosePrice).toHaveBeenCalledTimes(0);
  });
});
