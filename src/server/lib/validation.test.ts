import { describe, expect, it } from "bun:test";
import { Request } from "express";
import {
  requireQueryString,
  optionalQueryString,
  requireBodyObject,
  requireStringField,
  requireNumberField,
} from "./validation";

// Helper to create a mock Request with query params
const mockRequest = (query: Record<string, unknown>, body?: unknown): Request =>
  ({ query, body } as unknown as Request);

describe("requireQueryString", () => {
  it("should return success for valid string", () => {
    const req = mockRequest({ id: "abc123" });
    const result = requireQueryString(req, "id");
    expect(result.success).toBe(true);
    expect(result.data).toBe("abc123");
  });

  it("should fail for missing parameter", () => {
    const req = mockRequest({});
    const result = requireQueryString(req, "id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("should fail for array parameter", () => {
    const req = mockRequest({ id: ["a", "b"] });
    const result = requireQueryString(req, "id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("array");
  });

  it("should fail for empty string", () => {
    const req = mockRequest({ id: "" });
    const result = requireQueryString(req, "id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("should fail for whitespace-only string", () => {
    const req = mockRequest({ id: "   " });
    const result = requireQueryString(req, "id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty");
  });
});

describe("optionalQueryString", () => {
  it("should return undefined for missing parameter", () => {
    const req = mockRequest({});
    const result = optionalQueryString(req, "filter");
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("should return value for present parameter", () => {
    const req = mockRequest({ filter: "active" });
    const result = optionalQueryString(req, "filter");
    expect(result.success).toBe(true);
    expect(result.data).toBe("active");
  });

  it("should fail for array parameter", () => {
    const req = mockRequest({ filter: ["a", "b"] });
    const result = optionalQueryString(req, "filter");
    expect(result.success).toBe(false);
    expect(result.error).toContain("array");
  });
});

describe("requireBodyObject", () => {
  it("should return success for valid object", () => {
    const req = mockRequest({}, { name: "test" });
    const result = requireBodyObject(req);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "test" });
  });

  it("should fail for null body", () => {
    const req = mockRequest({}, null);
    const result = requireBodyObject(req);
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("should fail for array body", () => {
    const req = mockRequest({}, [1, 2, 3]);
    const result = requireBodyObject(req);
    expect(result.success).toBe(false);
    expect(result.error).toContain("object");
  });
});

describe("requireStringField", () => {
  it("should return success for valid string field", () => {
    const obj = { name: "test", value: 123 };
    const result = requireStringField(obj, "name");
    expect(result.success).toBe(true);
    expect(result.data).toBe("test");
  });

  it("should fail for missing field", () => {
    const obj = { value: 123 };
    const result = requireStringField(obj as any, "name");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("should fail for non-string field", () => {
    const obj = { name: 123 };
    const result = requireStringField(obj, "name" as keyof typeof obj);
    expect(result.success).toBe(false);
    expect(result.error).toContain("string");
  });
});

describe("requireNumberField", () => {
  it("should return success for valid number field", () => {
    const obj = { count: 42 };
    const result = requireNumberField(obj, "count");
    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });

  it("should fail for missing field", () => {
    const obj = {};
    const result = requireNumberField(obj as any, "count");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("should fail for non-number field", () => {
    const obj = { count: "42" };
    const result = requireNumberField(obj, "count" as keyof typeof obj);
    expect(result.success).toBe(false);
    expect(result.error).toContain("number");
  });

  it("should fail for NaN", () => {
    const obj = { count: NaN };
    const result = requireNumberField(obj, "count");
    expect(result.success).toBe(false);
    expect(result.error).toContain("number");
  });

  it("should fail for Infinity", () => {
    const obj = { count: Infinity };
    const result = requireNumberField(obj, "count");
    expect(result.success).toBe(false);
    expect(result.error).toContain("number");
  });
});
