import { describe, test, expect, afterEach } from "bun:test";
import { restoreEnv } from "test-helpers";
import { SECURITY_HEADERS, responseSecurityHeaders } from "./security-headers";

afterEach(restoreEnv);

describe("responseSecurityHeaders", () => {
  test("adds HSTS under the production posture", () => {
    process.env.NODE_ENV = "production";
    expect(responseSecurityHeaders()).toEqual({
      ...SECURITY_HEADERS,
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    });
  });

  test("is the baseline headers otherwise, as a copy the caller may add to", () => {
    process.env.NODE_ENV = "development";
    const headers = responseSecurityHeaders();
    expect(headers).toEqual(SECURITY_HEADERS);
    headers["Set-Cookie"] = "x";
    expect(SECURITY_HEADERS["Set-Cookie"]).toBeUndefined();
  });
});
