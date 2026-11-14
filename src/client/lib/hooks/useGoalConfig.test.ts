import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stubFetch } from "test-render";
import { loadAverageInflation, resetAverageInflationCache } from "./useGoalConfig";

const INFLATION = {
  year_over_year_inflation: 1.025,
  from: "1996-09",
  to: "2026-09",
  series_id: "CUUR0000SA0",
};

let fetchStub: ReturnType<typeof stubFetch> | undefined;

beforeEach(() => resetAverageInflationCache());

afterEach(() => {
  fetchStub?.restore();
  fetchStub = undefined;
});

describe("loadAverageInflation", () => {
  it("asks the server once and shares the answer", async () => {
    fetchStub = stubFetch([
      { path: "/api/inflation", response: { status: "success", body: INFLATION } },
    ]);
    const [a, b] = await Promise.all([loadAverageInflation(), loadAverageInflation()]);
    const c = await loadAverageInflation();

    expect(a).toEqual(INFLATION);
    expect(b).toEqual(INFLATION);
    expect(c).toEqual(INFLATION);
    expect(fetchStub.calls.requests).toHaveLength(1);
  });

  it("does not hold on to a null answer, so a later mount asks again", async () => {
    fetchStub = stubFetch([{ path: "/api/inflation", response: { status: "success", body: null } }]);
    expect(await loadAverageInflation()).toBeNull();
    expect(await loadAverageInflation()).toBeNull();
    expect(fetchStub.calls.requests).toHaveLength(2);
  });

  it("treats a failed request as no data and retries next time", async () => {
    fetchStub = stubFetch([
      { path: "/api/inflation", response: { status: "error", message: "boom" } },
    ]);
    expect(await loadAverageInflation()).toBeNull();
    expect(await loadAverageInflation()).toBeNull();
    expect(fetchStub.calls.requests).toHaveLength(2);
  });
});
