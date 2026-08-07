import { describe, it, expect } from "bun:test";
import { reconnectDelayMs } from "./useServerEvents";

describe("reconnectDelayMs", () => {
  it("backs off exponentially from one second", () => {
    const mid = () => 0.5; // midpoint of the jitter band
    expect(reconnectDelayMs(0, mid)).toBe(1_000);
    expect(reconnectDelayMs(1, mid)).toBe(2_000);
    expect(reconnectDelayMs(2, mid)).toBe(4_000);
    expect(reconnectDelayMs(3, mid)).toBe(8_000);
  });

  it("caps the backoff so a long outage still retries", () => {
    const mid = () => 0.5;
    expect(reconnectDelayMs(10, mid)).toBe(30_000);
    expect(reconnectDelayMs(100, mid)).toBe(30_000);
  });

  it("spreads a herd across a full backoff period, not a fraction of one", () => {
    // Every tab is knocked off by the same deploy. A band narrower than the
    // delay itself returns them in a clump: ±25% of the first attempt spread
    // the herd over 500ms, which is no spread at all against a server that
    // has just started.
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, () => 1)).toBe(1_500);
    expect(reconnectDelayMs(10, () => 0)).toBe(15_000);
    expect(reconnectDelayMs(10, () => 1)).toBe(45_000);
  });

  it("never returns a delay short enough to hammer the server", () => {
    for (let attempt = 0; attempt <= 12; attempt++) {
      expect(reconnectDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(500);
    }
  });

  it("treats a negative attempt as the first one", () => {
    expect(reconnectDelayMs(-1, () => 0.5)).toBe(1_000);
  });
});
