import { describe, test, expect, afterAll, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import ts from "typescript";
import { restoreEnv, restoreFetch } from "test-helpers";
import { SECURITY_HEADERS } from "./security-headers";
import { serveStatic } from "./static-files";

describe("serveStatic", () => {
  const clientPath = mkdtempSync(path.join(tmpdir(), "budget-static-"));
  writeFileSync(path.join(clientPath, "index.html"), "<!doctype html><title>index</title>");
  mkdirSync(path.join(clientPath, "assets"));
  writeFileSync(path.join(clientPath, "assets", "app.js"), "console.log(1);");

  beforeAll(restoreFetch);

  const server = Bun.serve({
    port: 0,
    fetch: (request) => serveStatic(clientPath, new URL(request.url).pathname),
  });

  afterAll(() => {
    restoreFetch();
    server.stop(true);
    rmSync(clientPath, { recursive: true, force: true });
  });

  const get = (pathname: string) => fetch(new URL(pathname, server.url));

  const cases = [
    { name: "the document at /", pathname: "/", contentType: "text/html", body: "<title>index</title>" },
    { name: "an SPA route via the index fallback", pathname: "/accounts", contentType: "text/html", body: "<title>index</title>" },
    { name: "a static asset", pathname: "/assets/app.js", contentType: "javascript", body: "console.log(1);" },
  ];

  for (const { name, pathname, contentType, body } of cases) {
    test(`${name} carries every security header and keeps its content type`, async () => {
      const response = await get(pathname);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(contentType);
      expect(await response.text()).toContain(body);
      for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
        expect([header, response.headers.get(header)]).toEqual([header, value]);
      }
    });
  }

  describe("HSTS", () => {
    afterEach(restoreEnv);

    test("is absent outside production", async () => {
      process.env["NODE_ENV"] = "development";
      expect((await get("/")).headers.get("strict-transport-security")).toBeNull();
    });

    test("is added in production", async () => {
      process.env["NODE_ENV"] = "production";
      expect((await get("/")).headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
    });
  });
});

describe("serveStatic — wiring", () => {
  const startPath = path.join(import.meta.dir, "../start.ts");
  const source = ts.createSourceFile(
    startPath,
    readFileSync(startPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  /** Every expression that constructs a `Response` from a `Bun.file(...)` in start.ts. */
  const bareFileResponses: string[] = [];
  let servesStatic = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "serveStatic") {
      servesStatic = node.arguments[0]?.getText(source) === "clientPath";
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === "Response" &&
      node.arguments?.some((argument) => argument.getText(source).includes("Bun.file"))
    ) {
      bareFileResponses.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  test("start.ts serves client files through serveStatic, not a bare Response", () => {
    expect(servesStatic).toBe(true);
    expect(bareFileResponses).toEqual([]);
  });
});
