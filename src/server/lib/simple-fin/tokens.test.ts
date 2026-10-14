import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { decodeAccessUrl, exchangeSetupToken, validateSimpleFinUrl } from "./tokens";
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

describe("validateSimpleFinUrl", () => {
  const verdict = (url: string) => {
    try {
      validateSimpleFinUrl(url, "setup token");
      return "allowed";
    } catch {
      return "refused";
    }
  };

  test("refuses private and internal hosts, including IPv6 literals and a trailing dot", () => {
    const refused = [
      "https://localhost/x",
      "https://LOCALHOST/x",
      "https://localhost./x",
      "https://metadata.google.internal./x",
      "https://127.0.0.1/x",
      "https://0x7f000001/x",
      "https://169.254.169.254/x",
      "https://[::1]/x",
      "https://[::]/x",
      "https://[fc00::1]/x",
      "https://[fdab::1]/x",
      "https://[fc12::1]/x",
      "https://[fe80::1]/x",
      "https://[febf::1]/x",
      "https://[::ffff:169.254.169.254]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::ffff:192.168.1.1]/x",
      "http://bridge.example.com/x",
    ];
    expect(refused.filter((url) => verdict(url) !== "refused")).toEqual([]);
  });

  test("allows public hosts, including ones whose names look like private prefixes", () => {
    const allowed = [
      "https://bridge.example.com/x",
      "https://fdab.example.com/x",
      "https://[2001:db8::1]/x",
      "https://[fec0::1]/x",
      "https://[::ffff:203.0.113.10]/x",
      "https://203.0.113.10/x",
    ];
    expect(allowed.filter((url) => verdict(url) !== "allowed")).toEqual([]);
  });
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

  test("a redirect fails the claim instead of reaching its target", async () => {
    // A server answering 307 to an internal address, as fetch sees it: followed unless refused.
    fetchMock.mockImplementationOnce(async (_input, init) => {
      if (init?.redirect === "error") throw new TypeError("UnexpectedRedirect");
      return new Response("internal secret");
    });
    await expect(exchangeSetupToken(tokenFor("https://bridge.example.com/claim/abc"))).rejects.toThrow("UnexpectedRedirect");
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

  test("fetches the host the allowlist checked, however many @ the URL has", () => {
    expect(decodeAccessUrl("https://user:pass@10.0.0.5@bridge.example.com/simplefin").url).toBe(
      "https://bridge.example.com/simplefin",
    );
    expect(decodeAccessUrl("https://bridge.example.com/@10.0.0.5").url).toBe("https://bridge.example.com/@10.0.0.5");
  });

  test("drops a trailing slash and decodes escaped credentials", () => {
    expect(decodeAccessUrl("https://us%40er:p%3Ass@bridge.example.com/simplefin/")).toEqual({
      url: "https://bridge.example.com/simplefin",
      credentials: Buffer.from("us@er:p:ss").toString("base64"),
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

  test("an access URL with a second @ is fetched from the host the allowlist checked", async () => {
    respond = async () => new Response(JSON.stringify({ errors: [], accounts: [] }));
    await getData(
      { ...item, access_token: "https://user:pass@10.0.0.5@bridge.example.com/simplefin" },
      { startDate: new Date("2026-10-01T00:00:00Z") },
    );
    expect(String(fetchMock.mock.calls[0][0])).toStartWith("https://bridge.example.com/simplefin/accounts?");
  });

  test("a stored access URL outside the allowlist is never fetched", async () => {
    await expect(
      getData({ ...item, access_token: "http://user:secret@169.254.169.254" }, { startDate: new Date() }),
    ).rejects.toThrow(/Invalid SimpleFin access URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
