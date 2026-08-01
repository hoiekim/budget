import { describe, it, expect } from "bun:test";
import { reconnectDelayMs } from "./useServerEvents";

describe("reconnectDelayMs", () => {
  it("backs off exponentially from one second", () => {
    const mid = () => 0.5; // no jitter
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

  it("jitters within ±25% so tabs knocked off together do not return together", () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(750);
    expect(reconnectDelayMs(0, () => 1)).toBe(1_250);
    expect(reconnectDelayMs(10, () => 0)).toBe(22_500);
    expect(reconnectDelayMs(10, () => 1)).toBe(37_500);
  });

  it("treats a negative attempt as the first one", () => {
    expect(reconnectDelayMs(-1, () => 0.5)).toBe(1_000);
  });
});
