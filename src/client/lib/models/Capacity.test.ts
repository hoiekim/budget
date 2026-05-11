import { test, expect, afterEach } from "bun:test";
import { Capacity } from "./Capacity";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const originalRandomUUID = globalThis.crypto?.randomUUID;
const originalGetRandomValues = globalThis.crypto?.getRandomValues;

afterEach(() => {
  if (!globalThis.crypto) return;
  if (originalRandomUUID) {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: originalRandomUUID,
      configurable: true,
      writable: true,
    });
  }
  if (originalGetRandomValues) {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      value: originalGetRandomValues,
      configurable: true,
      writable: true,
    });
  }
});

test("Capacity assigns a v4 UUID when crypto.randomUUID is available", () => {
  const c = new Capacity();
  expect(c.capacity_id).toMatch(UUID_V4_RE);
});

test("Capacity preserves an explicitly provided capacity_id", () => {
  const c = new Capacity({ capacity_id: "preset-id" });
  expect(c.capacity_id).toBe("preset-id");
});

test("Capacity falls back to manual UUID v4 when crypto.randomUUID is missing (issue #320)", () => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const c = new Capacity();
  expect(c.capacity_id).toMatch(UUID_V4_RE);
});

test("Capacity falls back to Math.random when both randomUUID and getRandomValues are missing", () => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const c = new Capacity();
  expect(c.capacity_id).toMatch(UUID_V4_RE);
});
