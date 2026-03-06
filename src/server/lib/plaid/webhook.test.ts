import { describe, expect, it } from "bun:test";
import { verifyWebhook } from "./webhook";

describe("Plaid Webhook Verification", () => {
  it("should reject missing Plaid-Verification header", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, undefined);
    expect(result).toBe(false);
  });

  it("should reject empty Plaid-Verification header", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, "");
    expect(result).toBe(false);
  });

  it("should reject malformed JWT", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, "not.a.valid.jwt");
    expect(result).toBe(false);
  });

  it("should reject JWT without key_id", async () => {
    // JWT with no kid in header: {"alg":"ES256","typ":"JWT"}
    const noKidJwt = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS" });
    const result = await verifyWebhook(body, noKidJwt);
    expect(result).toBe(false);
  });

  // Note: Full integration tests with real Plaid signatures would require
  // a test webhook from Plaid or mocking the key fetch. These unit tests
  // verify the rejection of invalid inputs.
});
