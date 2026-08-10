import { describe, expect, it } from "bun:test";
import type { ServerRequest } from "./route";
import {
  requireQueryString,
  optionalQueryString,
  requireBodyObject,
  requireStringField,
  requireNumberField,
  validateFields,
  validationError,
} from "./validation";
import type { FieldSpec } from "./validation";

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
/**
 * Client type errors must be answered as `status: "failed"` BEFORE any value
 * reaches SQL. Letting one through raises Postgres `22P02` at the write, which
 * `Route.execute` turns into a 500 **and** a `sendAlarm` call — and while
 * `alarm.ts` keeps a single global cooldown, one malformed request a minute
 * blinds every other server alarm. See issue 671.
 */
describe("validateFields", () => {
  const ACCOUNT_SPEC: FieldSpec[] = [
    { path: "hide", type: "boolean", nullable: true },
    { path: "label.budget_id", type: "uuid", nullable: true },
    { path: "balances.current", type: "number", nullable: true },
    { path: "balances.iso_currency_code", type: "string", nullable: true },
  ];
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  it("accepts a well-formed partial body", () => {
    const result = validateFields(
      { hide: true, label: { budget_id: UUID }, balances: { current: -12.5 } },
      ACCOUNT_SPEC
    );
    expect(result.success).toBe(true);
  });

  it("rejects a string in a numeric column and names the path", () => {
    const result = validateFields({ balances: { current: "abc" } }, ACCOUNT_SPEC);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Field balances.current must be a number");
  });

  it("rejects a non-UUID in a UUID column and names the path", () => {
    const result = validateFields({ label: { budget_id: "not-a-uuid" } }, ACCOUNT_SPEC);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Field label.budget_id must be a uuid");
  });

  it("accepts a UUID in either case", () => {
    for (const id of [UUID, UUID.toUpperCase()]) {
      expect(validateFields({ label: { budget_id: id } }, ACCOUNT_SPEC).success).toBe(true);
    }
  });

  it("rejects NaN and Infinity, which no numeric column accepts", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const result = validateFields({ balances: { current: value } }, ACCOUNT_SPEC);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Field balances.current must be a number");
    }
  });

  it("rejects a boolean column given a string", () => {
    const result = validateFields({ hide: "true" }, ACCOUNT_SPEC);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Field hide must be a boolean");
  });

  it("skips absent optional fields — these bodies are partial updates", () => {
    expect(validateFields({}, ACCOUNT_SPEC).success).toBe(true);
    expect(validateFields({ balances: {} }, ACCOUNT_SPEC).success).toBe(true);
  });

  it("skips a missing parent object without inspecting its leaves", () => {
    expect(validateFields({ label: undefined }, ACCOUNT_SPEC).success).toBe(true);
    expect(validateFields({ label: null }, ACCOUNT_SPEC).success).toBe(true);
  });

  it("rejects a parent that is present but not an object", () => {
    for (const label of ["abc", 5, [UUID]]) {
      const result = validateFields({ label }, ACCOUNT_SPEC);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Field label must be an object");
    }
  });

  it("accepts explicit null only where the column is nullable", () => {
    expect(validateFields({ hide: null }, ACCOUNT_SPEC).success).toBe(true);
    const strict: FieldSpec[] = [{ path: "hide", type: "boolean" }];
    const result = validateFields({ hide: null }, strict);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Field hide must be a boolean");
  });

  it("reports a required field that is absent or undefined", () => {
    const strict: FieldSpec[] = [{ path: "budget_id", type: "uuid", required: true }];
    for (const body of [{}, { budget_id: undefined }]) {
      const result = validateFields(body, strict);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Missing required field: budget_id");
    }
  });

  it("reports the FIRST failing spec, not the last", () => {
    const result = validateFields(
      { hide: "true", balances: { current: "abc" } },
      ACCOUNT_SPEC
    );
    expect(result.error).toBe("Field hide must be a boolean");
  });
});
