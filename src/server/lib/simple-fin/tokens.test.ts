import { describe, it, expect, mock, afterEach } from "bun:test";
import { exchangeSetupToken } from "./tokens";

const setupTokenFor = (url: string): string =>
  Buffer.from(url, "utf8").toString("base64");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("exchangeSetupToken", () => {
  it("returns the access URL on a 2xx response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve("https://user:pass@bridge.example.com/simplefin"),
      } as Response),
    );
    const result = await exchangeSetupToken(
      setupTokenFor("https://bridge.example.com/simplefin/claim/abc"),
    );
    expect(result).toBe("https://user:pass@bridge.example.com/simplefin");
  });

  it("throws instead of storing a non-2xx body as the access token", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: () => Promise.resolve("<html>bridge down</html>"),
      } as Response),
    );
    await expect(
      exchangeSetupToken(
        setupTokenFor("https://bridge.example.com/simplefin/claim/abc"),
      ),
    ).rejects.toThrow("SimpleFin token exchange failed: 502 Bad Gateway");
  });
});
