import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { decodeAccessUrl, exchangeSetupToken } from "./tokens";
import { getData } from "./data";
import type { JSONItem } from "common";

afterAll(restoreLeaves);

const ACCESS_URL = "https://user:secret@bridge.example.com/simplefin";
const tokenFor = (url: string) => Buffer.from(url).toString("base64");

let respond: () => Promise<Response> = async () => new Response(ACCESS_URL);
const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) => respond());

beforeEach(() => {
  fetchMock.mockClear();
  respond = async () => new Response(ACCESS_URL);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("exchangeSetupToken", () => {
  test("claims with redirects refused, and returns the access URL", async () => {
    expect(await exchangeSetupToken(tokenFor("https://bridge.example.com/claim/abc"))).toBe(ACCESS_URL);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
  });

  test("a setup URL outside the allowlist is never fetched", async () => {
    for (const url of ["http://bridge.example.com/claim/abc", "https://169.254.169.254/claim", "https://localhost/claim"]) {
      await expect(exchangeSetupToken(tokenFor(url))).rejects.toThrow(/Invalid SimpleFin setup token/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a redirect fails the claim", async () => {
    respond = () => Promise.reject(new TypeError("fetch failed (unexpected redirect)"));
    await expect(exchangeSetupToken(tokenFor("https://bridge.example.com/claim/abc"))).rejects.toThrow(/redirect/);
  });

  test("a claimed access URL outside the allowlist is refused", async () => {
    for (const url of ["http://user:secret@bridge.example.com/simplefin", "https://user:secret@169.254.169.254/simplefin"]) {
      respond = async () => new Response(url);
      await expect(exchangeSetupToken(tokenFor("https://bridge.example.com/claim/abc"))).rejects.toThrow(
        /Invalid SimpleFin access URL/,
      );
    }
  });

  test("a refused claim's body is returned for the caller to report", async () => {
    respond = async () => new Response("Forbidden", { status: 403 });
    expect(await exchangeSetupToken(tokenFor("https://bridge.example.com/claim/abc"))).toBe("Forbidden");
  });
});

describe("decodeAccessUrl", () => {
  test("splits the credentials from the URL", () => {
    expect(decodeAccessUrl(ACCESS_URL)).toEqual({
      url: "https://bridge.example.com/simplefin",
      credentials: Buffer.from("user:secret").toString("base64"),
    });
  });

  test("refuses an access URL outside the allowlist", () => {
    expect(() => decodeAccessUrl("http://user:secret@bridge.example.com/simplefin")).toThrow(/must use HTTPS/);
    expect(() => decodeAccessUrl("https://user:secret@10.0.0.5/simplefin")).toThrow(/private\/reserved range/);
  });
});

describe("getData", () => {
  const item = { item_id: "i-1", access_token: ACCESS_URL } as JSONItem;

  test("fetches accounts with redirects refused", async () => {
    respond = async () => new Response(JSON.stringify({ errors: [], accounts: [] }));
    await getData(item, { startDate: new Date("2026-10-01T00:00:00Z") });
    expect(String(fetchMock.mock.calls[0][0])).toStartWith("https://bridge.example.com/simplefin/accounts?");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  test("a stored access URL outside the allowlist is never fetched", async () => {
    await expect(
      getData({ ...item, access_token: "http://user:secret@169.254.169.254" }, { startDate: new Date() }),
    ).rejects.toThrow(/Invalid SimpleFin access URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
