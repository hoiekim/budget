import { describe, expect, it } from "bun:test";
import { LocalDate } from "common";
import type { ServerRequest } from "./route";
import {
  requireQueryString,
  optionalQueryString,
  requireBodyObject,
  requireStringField,
  requireNumberField,
  optionalDateField,
  validationError,
} from "./validation";

// Helper to create a mock ServerRequest with query params
const mockRequest = (query: Record<string, unknown>, body?: unknown): ServerRequest =>
  ({ query, body } as unknown as ServerRequest);

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
    const obj = { value: 123 } as Record<string, unknown>;
    const result = requireStringField(obj, "name");
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
    const obj = {} as Record<string, unknown>;
    const result = requireNumberField(obj, "count");
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

describe("optionalQueryString edge cases", () => {
  it("should return undefined for empty string", () => {
    const req = mockRequest({ filter: "" });
    const result = optionalQueryString(req, "filter");
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("should return undefined for null parameter", () => {
    const req = mockRequest({ filter: null });
    const result = optionalQueryString(req, "filter");
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });
});

describe("requireQueryString edge cases", () => {
  it("should fail for null parameter", () => {
    const req = mockRequest({ id: null });
    const result = requireQueryString(req, "id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("should fail for non-string types", () => {
    const req = mockRequest({ id: 123 });
    const result = requireQueryString(req, "id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("string");
  });
});

describe("requireBodyObject edge cases", () => {
  it("should fail for undefined body", () => {
    const req = mockRequest({}, undefined);
    const result = requireBodyObject(req);
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("should fail for primitive body", () => {
    const req = mockRequest({}, "string body");
    const result = requireBodyObject(req);
    expect(result.success).toBe(false);
    expect(result.error).toContain("object");
  });
});

describe("validationError", () => {
  it("should return failed status with message", () => {
    const result = validationError("Invalid input");
    expect(result.status).toBe("failed");
    expect(result.message).toBe("Invalid input");
  });
});

describe("optionalDateField", () => {
  it("should return undefined for an absent, null or empty value", () => {
    for (const obj of [{}, { date: null }, { date: "" }]) {
      const result = optionalDateField(obj as Record<string, unknown>, "date");
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    }
  });

  // `LocalDate` reads a bare YYYY-MM-DD as local midnight; the built-in `Date`
  // reads it as UTC. Asserting the subclass is what distinguishes them — the
  // test runner pins UTC, so no in-process clock comparison can.
  it("should parse a valid date string as a LocalDate, not a bare Date", () => {
    const result = optionalDateField({ date: "2024-03-15" }, "date");
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(LocalDate);
    expect(Number.isNaN(result.data!.getTime())).toBe(false);
  });

  it("should reject a non-string value rather than reading a number as epoch ms", () => {
    for (const date of [20260701, { $ne: null }, ["2024-03-15"], true]) {
      const result = optionalDateField({ date } as Record<string, unknown>, "date");
      expect(result.success).toBe(false);
      expect(result.error).toContain("must be a string");
      expect(result.data).toBeUndefined();
    }
  });

  it("should reject an unparseable date string", () => {
    for (const date of ["garbage", "2026-13-45x"]) {
      const result = optionalDateField({ date }, "date");
      expect(result.success).toBe(false);
      expect(result.error).toContain("is not a valid date");
    }
  });

  it("should name the field in the error, or the label when one is given", () => {
    expect(optionalDateField({ snapshot_date: 7 } as Record<string, unknown>, "snapshot_date").error)
      .toBe("snapshot_date must be a string");
    expect(optionalDateField({ date: 7 } as Record<string, unknown>, "date", "snapshot.date").error)
      .toBe("snapshot.date must be a string");
  });
});
