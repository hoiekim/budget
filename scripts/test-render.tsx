/**
 * React render-test scaffolding.
 *
 * The client's page components read everything they need from
 * `AppContext`, so rendering one in isolation means supplying a
 * `ContextType`. `buildContext` assembles a real one out of the real
 * models — `new Data()`, `new Calculations()`, `new ViewDate(...)` — so a
 * test exercises production code paths rather than a parallel fake.
 *
 * The two seams a page reaches through are stubbed at their outermost
 * edge instead of with `mock.module`:
 *
 *   - the network, via `stubFetch` — `client/lib/call` is left intact and
 *     runs for real on top of a stubbed `globalThis.fetch`.
 *   - navigation, via `buildRouter` — `ClientRouter` is an interface, so a
 *     recording object satisfies it.
 *
 * `mock.module` is process-global in bun and has no unmock API, so a
 * module-level mock installed here would leak into every later test file.
 *
 * Usage:
 *
 *   import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
 *   import { cleanup } from "@testing-library/react";
 *   import { afterEach } from "bun:test";
 *
 *   afterEach(() => {
 *     cleanup();
 *     resetDom();
 *   });
 */
import { ReactElement } from "react";
import { render, RenderResult } from "@testing-library/react";
import {
  Calculations,
  ClientRouter,
  Context,
  ContextType,
  Data,
  PATH,
  ScreenType,
  Status,
} from "client";
import { ViewDate } from "common";

/**
 * Clear the DOM's persistent stores. happy-dom registers one `localStorage` and
 * one `sessionStorage` for the whole process and `cleanup()` leaves both
 * standing, so a key that a page's mount effect writes — `setBudgetsOrder` in
 * `client/lib/hooks/cache`, the router's `"path"` — is still there for whichever
 * file bun runs next. Call this from the same `afterEach` as `cleanup`.
 */
export const resetDom = () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
};

/** Navigation a page asked for, in call order. */
export interface RouterCalls {
  go: { path: PATH; params: URLSearchParams | undefined }[];
  back: number;
  forward: number;
}

/**
 * A `ClientRouter` that records navigation instead of performing it.
 * `getActiveParams` always answers `params`, which is what a page reads to
 * find the entity it is configuring.
 */
export const buildRouter = (path: PATH, params = new URLSearchParams()) => {
  const calls: RouterCalls = { go: [], back: 0, forward: 0 };
  const router: ClientRouter = {
    path,
    params,
    transition: {
      incomingPath: path,
      incomingParams: params,
      transitioning: false,
      direction: undefined,
      slideAnchorY: 0,
    },
    getActiveParams: () => params,
    go: (goPath, options) => {
      calls.go.push({ path: goPath, params: options?.params });
    },
    forward: () => {
      calls.forward += 1;
    },
    back: () => {
      calls.back += 1;
    },
    canGoBack: true,
  };
  return { router, calls };
};

/**
 * A `ContextType` built from real models. `viewDate` is pinned rather than
 * defaulted to `new Date()` so a period boundary can't make a test flake
 * overnight.
 */
export const buildContext = (overrides: Partial<ContextType> = {}): ContextType => ({
  data: new Data(),
  setData: () => {},
  calculations: new Calculations(),
  calculate: Object.assign(() => {}, { cache: { capacityData: () => {} } }),
  status: new Status(),
  user: undefined,
  setUser: () => {},
  router: buildRouter(PATH.BUDGETS).router,
  viewDate: new ViewDate("month", new Date(2026, 0, 15)),
  setViewDate: () => {},
  resetViewDate: () => {},
  screenType: ScreenType.Narrow,
  ...overrides,
});

/**
 * Render `ui` under a `Context.Provider`. The returned `rerender` re-wraps
 * with a fresh context, which is how a test reproduces the re-render a data
 * sync or a `calculate.cache` update causes in the running app.
 */
export const renderWithContext = (
  ui: ReactElement,
  context: ContextType,
): RenderResult & { rerenderWithContext: (next: ContextType) => void } => {
  const result = render(<Context.Provider value={context}>{ui}</Context.Provider>);
  return {
    ...result,
    rerenderWithContext: (next: ContextType) => {
      result.rerender(<Context.Provider value={next}>{ui}</Context.Provider>);
    },
  };
};

/** A single `fetch` exchange the stub should answer. */
export interface FetchStubRoute {
  /** Matched against the request path with `String.includes`. */
  path: string;
  /** Parsed by `client/lib/call` as the `ApiResponse` JSON body. */
  response: unknown;
  /** Awaited before the response is handed back. A promise left pending
   *  holds the request open, which is how a test reads a component's
   *  in-flight state off the live DOM instead of inferring it. */
  hold?: Promise<unknown>;
}

/** Requests a page made, in call order. */
export interface FetchCalls {
  requests: { url: string; method: string }[];
}

/**
 * Replace `globalThis.fetch` for the duration of a test. Returns the recorded
 * calls and a `restore` — run it from `afterEach`, not from the end of the
 * test body, or an assertion that throws mid-test leaves every later test
 * file in the process talking to this stub.
 *
 * An unmatched path throws, so a page can never reach the real network from a
 * test. `client/lib/call` catches that throw and turns it into an error
 * `ApiResponse`, so the symptom is the page taking its failure branch —
 * `calls.requests` is what tells you which path went unstubbed.
 */
export const stubFetch = (routes: FetchStubRoute[]) => {
  const original = globalThis.fetch;
  const calls: FetchCalls = { requests: [] };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.requests.push({ url, method: init?.method || "GET" });
    const route = routes.find((r) => url.includes(r.path));
    if (!route) throw new Error(`test-render: no fetch stub for ${init?.method || "GET"} ${url}`);
    if (route.hold) await route.hold;
    return new Response(JSON.stringify(route.response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
};
