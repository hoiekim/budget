import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { CLIENT_DIR, startStack, type ApiClient, type Stack } from "../harness";

let stack: Stack;
let admin: ApiClient;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
});
afterAll(() => stack.stop());

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-xss-protection": "1; mode=block",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy":
    "default-src 'self'; script-src 'self' https://cdn.plaid.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.plaid.com; frame-src https://cdn.plaid.com; font-src 'self' data:; object-src 'none'; base-uri 'self'",
};

const expectSecurityHeaders = (headers: Headers) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers.get(name)).toBe(value);
  expect(headers.get("strict-transport-security")).toBeNull();
};

/** One raw HTTP/1.1 exchange, for what `fetch` will not send or show. */
const raw = (request: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(stack.port, "127.0.0.1");
    let response = "";
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
    });
    socket.on("end", () => resolve(response));
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(response);
    }, 4000);
  });

describe("the authentication gate", () => {
  test("refuses an anonymous caller on every path that is not public, whether or not a route serves it", async () => {
    const anonymous = stack.anonymous();
    for (const [method, path] of [
      ["GET", "/accounts"],
      ["GET", "/nope"],
      ["POST", "/nope"],
      ["DELETE", "/budget"],
      ["GET", "/"],
      ["GET", "/login/extra"],
      ["GET", "/Login"],
      ["POST", "/health"],
      ["HEAD", "/health"],
      ["GET", "/plaid-hook"],
      ["OPTIONS", "/accounts"],
      ["PUT", "/accounts"],
      ["PATCH", "/accounts"],
      ["GET", "/auth/login"],
      ["GET", "/auth/callback"],
      ["POST", "/auth/events"],
      ["POST", "/client-error"],
      ["GET", "/events"],
    ]) {
      const result = await anonymous.request(method, path);
      expect([method, path, result.status]).toEqual([method, path, 401]);
      if (method !== "HEAD") expect(result.json).toEqual({ status: "failed", message: "Not authenticated." });
      expect(result.headers.get("content-type")).toBe("application/json");
      expectSecurityHeaders(result.headers);
      expect(result.setCookies).toEqual([]);
    }
  });

  test("answers a signed-in caller 404 where no route matches the path and method", async () => {
    for (const [method, path] of [
      ["GET", "/nope"],
      ["POST", "/nope"],
      ["PUT", "/login"],
      ["PATCH", "/login"],
      ["OPTIONS", "/login"],
      ["POST", "/health"],
      ["GET", "/"],
      ["GET", "/login/"],
      ["GET", "//api//login"],
      ["GET", "/LOGIN"],
      ["POST", "/auth/login"],
      ["DELETE", "/auth/callback"],
      ["GET", "/auth/events"],
    ]) {
      const result = await admin.request(method, path);
      expect([method, path, result.status]).toEqual([method, path, 404]);
      expect(result.json).toEqual({ status: "error", message: "Not Found" });
      expectSecurityHeaders(result.headers);
      // Shed before any route ran: the session cookie is not refreshed.
      expect(result.setCookies).toEqual([]);
    }
  });

  test("answers the single sign-on routes like unknown ones while it is off, though a route did run", async () => {
    const sid = admin.cookies.get("session_id");
    for (const [method, path] of [
      ["GET", "/auth/login"],
      ["GET", "/auth/callback"],
      ["POST", "/auth/events"],
    ]) {
      const result = await admin.request(method, path);
      expect([method, path, result.status]).toEqual([method, path, 404]);
      expect(result.json).toEqual({ status: "error", message: "Not Found" });
      expect(result.setCookies).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);
    }
  });

  test("lets anyone reach the public paths, by method", async () => {
    const anonymous = stack.anonymous();
    expect((await anonymous.get("/health")).status).toBe(200);
    expect((await anonymous.get("/login")).status).toBe(200);
    // /login is public for every method: an unknown one is 404, not 401.
    expect((await anonymous.request("PUT", "/login")).status).toBe(404);
    expect((await anonymous.request("PATCH", "/login")).status).toBe(404);
  });

  test("answers HEAD like the matching request would be routed, without a body", async () => {
    const head = await stack.anonymous().request("HEAD", "/login");
    expect(head.status).toBe(404);
    expect(head.text).toBe("");
    expect(head.headers.get("content-type")).toBe("application/json");
  });

  test("treats the path literally: no trailing slash, case folding or percent-decoding", async () => {
    const anonymous = stack.anonymous();
    expect((await anonymous.get("/login/")).status).toBe(401);
    expect((await anonymous.get("/LOGIN")).status).toBe(401);
    expect((await anonymous.get("/%6cogin")).status).toBe(401);
    expect((await anonymous.get("/login%2F")).status).toBe(401);
    // Dot segments are resolved before routing.
    expect((await anonymous.get("/x/../login")).status).toBe(200);
    expect((await anonymous.get("/./login")).status).toBe(200);
    expect((await anonymous.get("/x/%2e%2e/login")).status).toBe(200);
    // The query string is not part of the path.
    expect((await anonymous.get("/login?x=1&x=2&y=%20a+b&z")).status).toBe(200);
    expect((await anonymous.get("/login?")).status).toBe(200);
    expect((await anonymous.get("/login#fragment")).status).toBe(200);
  });

  test("serves /api itself as the route path /", async () => {
    expect((await stack.anonymous().get("//api")).status).toBe(401);
    expect((await admin.get("//api")).status).toBe(404);
    expect((await admin.get("//api/")).status).toBe(404);
  });
});

describe("the session cookie", () => {
  test("is refreshed on every routed response and slides the stored expiry", async () => {
    const client = await stack.login();
    const sid = client.cookies.get("session_id")!;
    await stack.db.query("UPDATE sessions SET cookie_expires = now() + interval '1 hour' WHERE session_id = $1", [sid]);
    const result = await client.get("/login");
    expect(result.setCookies).toEqual([`session_id=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict`]);
    const row = await stack.db.one<{ cookie_expires: Date }>("SELECT cookie_expires FROM sessions WHERE session_id = $1", [sid]);
    expect(Math.abs(row!.cookie_expires.getTime() - (Date.now() + 604_800_000))).toBeLessThan(60_000);
  });

  test("an unknown, empty or expired session id is anonymous, and an expired row is deleted on sight", async () => {
    const anonymous = stack.anonymous();
    for (const cookie of ["session_id=unknown", "session_id=", "session_id", "other=1", "", ";;;", "session_id=a; session_id=b"]) {
      const result = await anonymous.get("/login", { headers: { Cookie: cookie } });
      expect(result.json.message).toBe("Not logged in.");
      expect(result.setCookies).toEqual([]);
    }
    const client = await stack.login();
    const sid = client.cookies.get("session_id")!;
    await stack.db.query("UPDATE sessions SET cookie_expires = now() - interval '1 second' WHERE session_id = $1", [sid]);
    expect((await client.get("/login")).json.message).toBe("Not logged in.");
    expect(await stack.db.rows("sessions", { session_id: sid })).toHaveLength(0);
  });

  test("a stored session with no recorded expiry still signs in", async () => {
    const client = await stack.login();
    const sid = client.cookies.get("session_id")!;
    await stack.db.query("UPDATE sessions SET cookie_expires = NULL WHERE session_id = $1", [sid]);
    const result = await client.get<{ user: { username: string } }>("/login");
    expect(result.body.user.username).toBe("admin");
  });

  test("reads the session id among other cookies, percent-decoded, last one winning", async () => {
    const client = await stack.login();
    const sid = client.cookies.get("session_id")!;
    const who = async (cookie: string) =>
      (await stack.anonymous().get<{ user?: { username: string } }>("/login", { headers: { Cookie: cookie } })).body.user?.username;
    expect(await who(`a=1; session_id=${sid}; b=2`)).toBe("admin");
    expect(await who(`  session_id = ${sid} `)).toBe("admin");
    expect(await who(`session_id=${encodeURIComponent(sid).replace(/-/g, "%2D")}`)).toBe("admin");
    expect(await who(`session_id=nope; session_id=${sid}`)).toBe("admin");
    expect(await who(`session_id=${sid}; session_id=nope`)).toBeUndefined();
    expect(await who(`SESSION_ID=${sid}`)).toBeUndefined();
  });

  test("a session row that fails the model's checks is treated as no session", async () => {
    const client = await stack.login();
    const sid = client.cookies.get("session_id")!;
    await stack.db.query("UPDATE sessions SET cookie_same_site = 'sideways' WHERE session_id = $1", [sid]);
    expect((await client.get("/login")).json.message).toBe("Not logged in.");
  });

  test("a malformed percent-escape in any cookie fails the request", async () => {
    // The Bun server answers with its development error page here, so only the status is compared.
    const result = await stack.anonymous().get("/login", { headers: { Cookie: "theme=%E0%A4%A" }, noCompare: true });
    expect(result.status).toBe(500);
  });

  test("the session still names its user after the user row changes", async () => {
    const client = await stack.login("demo");
    const userId = await stack.userId("demo");
    await stack.db.query("UPDATE users SET username = 'demo-renamed' WHERE user_id = $1", [userId]);
    const result = await client.get<{ user: { username: string; user_id: string } }>("/login");
    expect(result.body.user).toEqual({ user_id: userId, username: "demo" });
    await stack.db.query("UPDATE users SET username = 'demo' WHERE user_id = $1", [userId]);
  });
});

describe("request bodies", () => {
  const big = (bytes: number) => "a".repeat(bytes);

  test("accepts a body of exactly one megabyte and refuses one byte more with 413", async () => {
    const anonymous = stack.anonymous();
    const atLimit = await anonymous.request("POST", "/login", {
      rawBody: big(1024 * 1024),
      headers: { "Content-Type": "application/json", "X-Real-IP": "10.5.0.1" },
      noCompare: true,
    });
    expect(atLimit.status).toBe(200);
    expect(atLimit.json).toEqual({ status: "failed", message: "Request body is required" });

    const response = await raw(
      `POST /api/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${1024 * 1024 + 1}\r\nConnection: close\r\n\r\n`,
    );
    expect(response.split("\r\n")[0]).toMatch(/^HTTP\/1\.1 413 /);
  });

  test("refuses an oversized body on a client path too, before reading it", async () => {
    const response = await raw(
      `POST /some/page HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${5 * 1024 * 1024}\r\nConnection: close\r\n\r\n`,
    );
    expect(response.split("\r\n")[0]).toMatch(/^HTTP\/1\.1 413 /);
  });

  test("refuses an oversized chunked body", async () => {
    const chunk = big(64 * 1024);
    const chunks = Array.from({ length: 17 }, () => `${chunk.length.toString(16)}\r\n${chunk}\r\n`).join("");
    const response = await raw(
      `POST /api/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunks}0\r\n\r\n`,
    );
    expect(response).toMatch(/HTTP\/1\.1 413 /);
  });

  test("parses JSON only when the content type says JSON", async () => {
    const send = (contentType: string | undefined, rawBody: string) =>
      stack.anonymous().request("POST", "/login", {
        rawBody,
        headers: { ...(contentType ? { "Content-Type": contentType } : {}), "X-Real-IP": "10.5.0.2" },
      });
    const valid = JSON.stringify({ username: 1 });
    expect((await send("application/json", valid)).json.message).toBe("Field username must be a string");
    expect((await send("application/json;charset=UTF-8", valid)).json.message).toBe("Field username must be a string");
    expect((await send("text/plain; note=application/json", valid)).json.message).toBe("Field username must be a string");
    expect((await send("APPLICATION/JSON", valid)).json.message).toBe("Request body is required");
    expect((await send("application/x-www-form-urlencoded", "username=admin")).json.message).toBe("Request body is required");
    expect((await send("text/json", valid)).json.message).toBe("Request body is required");
    expect((await send(undefined, valid)).json.message).toBe("Request body is required");
    for (const invalid of ["", " ", "{", "{'username':1}", "{\"username\":1,}", "undefined", "NaN"]) {
      expect((await send("application/json", invalid)).json.message).toBe("Request body is required");
    }
    for (const [scalar, message] of [
      ["null", "Request body is required"],
      ["true", "Request body must be an object"],
      ["0", "Request body must be an object"],
      ['"text"', "Request body must be an object"],
      ["[1]", "Request body must be an object"],
      [" \n{ \"username\" : 1 }\t", "Field username must be a string"],
    ]) {
      expect((await send("application/json", scalar)).json.message).toBe(message);
    }
  });

  test("a repeated key keeps its last value, and unknown keys are ignored", async () => {
    const result = await stack.anonymous().request("POST", "/login", {
      rawBody: '{"username":"admin","username":7,"password":"x","extra":{"deep":[1,2,3]}}',
      headers: { "Content-Type": "application/json", "X-Real-IP": "10.5.0.3" },
    });
    expect(result.json.message).toBe("Field username must be a string");
  });
});

describe("the client files", () => {
  const index = fs.readFileSync(path.join(CLIENT_DIR, "index.html"), "utf8");
  const page = (pathname: string, options: Parameters<ApiClient["request"]>[2] = {}) =>
    stack.anonymous().request("GET", `/${pathname}`, options);

  test("serves the app shell at / without the API's headers", async () => {
    const result = await page("/");
    expect(result.status).toBe(200);
    expect(result.text).toBe(index);
    expect(result.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(result.headers.get("content-length")).toBe(String(Buffer.byteLength(index)));
    expect(result.headers.get("content-security-policy")).toBeNull();
    expect(result.headers.get("x-frame-options")).toBeNull();
    expect(result.setCookies).toEqual([]);
  });

  test("serves a file that exists with a content type from its extension", async () => {
    for (const [file, type] of [
      ["index.html", "text/html;charset=utf-8"],
      ["public/manifest.json", "application/json;charset=utf-8"],
      ["public/robots.txt", "text/plain;charset=utf-8"],
      ["public/icons/favicon.ico", "image/x-icon"],
      ["public/icons/logo192.png", "image/png"],
      ["public/static-data/voo_price_history.csv", "text/csv"],
      ["start.tsx", "text/javascript;charset=utf-8"],
      ["sw.ts", "text/javascript;charset=utf-8"],
    ]) {
      const expected = fs.readFileSync(path.join(CLIENT_DIR, file));
      const response = await fetch(`${stack.origin}/${file}`);
      const body = Buffer.from(await response.arrayBuffer());
      expect([file, response.status]).toEqual([file, 200]);
      expect([file, response.headers.get("content-type")]).toEqual([file, type]);
      expect(body.equals(expected)).toBe(true);
    }
  });

  test("falls back to the app shell for anything that is not a file", async () => {
    for (const pathname of [
      "/some/app/route",
      "/public",
      "/public/",
      "/public/icons",
      "/missing.js",
      "/missing.png",
      "/api-key-detail",
      "/apix",
      "/API/login",
      "/index.htm",
      "/public/robots.txt/",
      "/public/robots%2Etxt",
      "/public%2Frobots.txt",
      "/.env",
      "/..%2F..%2Fetc%2Fhostname",
    ]) {
      const result = await page(pathname);
      expect([pathname, result.status]).toEqual([pathname, 200]);
      expect(result.text).toBe(index);
      expect(result.headers.get("content-type")).toBe("text/html;charset=utf-8");
    }
  });

  test("never leaves the client directory", async () => {
    for (const target of ["/../../../../etc/hostname", "/%2e%2e/%2e%2e/%2e%2e/etc/hostname", "/public/../../../package.json", "/..\\..\\package.json"]) {
      const response = await raw(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      expect(response.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
      expect(response).toContain("<!DOCTYPE html>");
      expect(response).not.toContain('"name": "budget"');
    }
  });

  test("answers any method on a client path with the file", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const result = await stack.anonymous().request(method, "//public/robots.txt");
      expect([method, result.status]).toEqual([method, 200]);
      expect(result.text).toContain("User-agent");
    }
    const head = await stack.anonymous().request("HEAD", "//public/robots.txt");
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(head.headers.get("content-length")).toBe("67");
  });

  test("serves byte ranges", async () => {
    const robots = fs.readFileSync(path.join(CLIENT_DIR, "public/robots.txt"), "utf8");
    const range = (value: string) => page("/public/robots.txt", { headers: { Range: value } });

    const first = await range("bytes=0-9");
    expect(first.status).toBe(206);
    expect(first.text).toBe(robots.slice(0, 10));
    expect(first.headers.get("content-range")).toBe(`bytes 0-9/${robots.length}`);
    expect(first.headers.get("accept-ranges")).toBe("bytes");
    expect(first.headers.get("content-type")).toBe("text/plain;charset=utf-8");

    const suffix = await range("bytes=-5");
    expect(suffix.status).toBe(206);
    expect(suffix.text).toBe(robots.slice(-5));
    expect(suffix.headers.get("content-range")).toBe(`bytes ${robots.length - 5}-${robots.length - 1}/${robots.length}`);

    const open = await range("bytes=60-");
    expect(open.status).toBe(206);
    expect(open.text).toBe(robots.slice(60));

    const pastEnd = await range("bytes=10-9999");
    expect(pastEnd.status).toBe(206);
    expect(pastEnd.text).toBe(robots.slice(10));

    const unsatisfiable = await range("bytes=500-600");
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${robots.length}`);
    expect(unsatisfiable.text).toBe("");

    for (const ignored of ["bytes=0-1,4-5", "lines=1-2", "bytes=abc", "bytes=5-2"]) {
      const whole = await range(ignored);
      expect([ignored, whole.status]).toEqual([ignored, 200]);
      expect(whole.text).toBe(robots);
    }
  });
});
