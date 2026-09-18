import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import ts from "typescript";
import { MAX_REQUEST_BODY_SIZE } from "./request-limits";

/**
 * Two questions, and neither answers the other.
 *
 * The first is what the ceiling DOES: `Bun.serve` has to refuse an over-limit
 * body before the handler runs, or the value buys nothing — the cost this
 * guards against is the read and the parse, not the response code.
 *
 * The second is whether the running server still asks for it. That one is the
 * regression on record: the express-era cap was deleted by a migration that
 * touched no test, because no test named the server's own configuration. A
 * behavioural test that stands up its own server cannot see that deletion, so
 * the wiring is asserted against the source that configures the real one.
 */

const body = (bytes: number) => "a".repeat(bytes);

describe("MAX_REQUEST_BODY_SIZE — enforcement", () => {
  let handlerEntered = false;

  // Whichever files ran first may have left a stubbed `fetch` behind; this one
  // needs the real network stack to reach the server below. Scoped to this
  // block so the next file inherits whatever it would have inherited anyway.
  const inheritedFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (globalThis as { __REAL_FETCH?: typeof fetch }).__REAL_FETCH ?? inheritedFetch;
  });

  const server = Bun.serve({
    port: 0,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    async fetch(request) {
      handlerEntered = true;
      return new Response(String((await request.text()).length));
    },
  });

  afterAll(() => {
    globalThis.fetch = inheritedFetch;
    server.stop(true);
  });

  const post = (payload: string) =>
    fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

  test("a body at the limit is delivered to the handler", async () => {
    handlerEntered = false;
    const response = await post(body(MAX_REQUEST_BODY_SIZE));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(String(MAX_REQUEST_BODY_SIZE));
    expect(handlerEntered).toBe(true);
  });

  test("one byte over the limit is refused, and the handler never runs", async () => {
    handlerEntered = false;
    const response = await post(body(MAX_REQUEST_BODY_SIZE + 1));

    expect(response.status).toBe(413);
    expect(handlerEntered).toBe(false);
  });
});

describe("MAX_REQUEST_BODY_SIZE — wiring", () => {
  const startPath = path.join(import.meta.dir, "../start.ts");

  const source = ts.createSourceFile(
    startPath,
    readFileSync(startPath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

  /** The options object literal `start.ts` hands to `Bun.serve`. */
  const serveOptions = (): ts.ObjectLiteralExpression => {
    let found: ts.ObjectLiteralExpression | undefined;

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "Bun.serve" &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        found = node.arguments[0];
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    if (!found) throw new Error("no Bun.serve({ ... }) call found in start.ts");
    return found;
  };

  test("start.ts passes the shared constant to Bun.serve", () => {
    const option = serveOptions().properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(source) === "maxRequestBodySize"
    );

    expect(option).toBeDefined();
    expect((option as ts.PropertyAssignment).initializer.getText(source)).toBe(
      "MAX_REQUEST_BODY_SIZE"
    );
  });
});
