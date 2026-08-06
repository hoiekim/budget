import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { ErrorBoundary } from "./index";

// Boundary-caught errors don't bubble to `window.addEventListener("error")`,
// so start.tsx's beacon never fires for them. componentDidCatch must send
// the beacon itself; these tests pin that.

describe("ErrorBoundary.componentDidCatch", () => {
  let beaconCalls: Array<{ url: string; body: string }>;
  let originalSendBeacon: typeof navigator.sendBeacon;
  let originalLocation: Location;

  beforeEach(() => {
    beaconCalls = [];
    originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = mock((url: string | URL, data?: BodyInit | null): boolean => {
      const bodyStr =
        typeof data === "string"
          ? data
          : data instanceof Blob
            ? "" // Blob body captured via mock.calls[i][1] below.
            : String(data);
      beaconCalls.push({ url: String(url), body: bodyStr });
      return true;
    });
    // Bun's test runtime has `window` but no `window.location`. The
    // component under test reads `window.location.href` — stub it so the
    // beacon body has a URL string. Save the original so the afterEach
    // restore doesn't leak between suites.
    originalLocation = (window as unknown as { location: Location }).location;
    (window as unknown as { location: Location }).location = {
      href: "http://localhost/test",
    } as Location;
  });

  afterEach(() => {
    navigator.sendBeacon = originalSendBeacon;
    (window as unknown as { location: Location | undefined }).location = originalLocation;
  });

  it("posts to /api/client-error with message + stack + url", async () => {
    const eb = new ErrorBoundary({ children: null });
    const err = new Error("boom");
    err.stack = "Error: boom\n    at somewhere:1:1";
    eb.componentDidCatch(err, { componentStack: "\n    at Foo\n    at Bar" } as React.ErrorInfo);

    expect(beaconCalls.length).toBe(1);
    expect(beaconCalls[0].url).toBe("/api/client-error");
    // Body was serialized into a Blob — capture separately by reading the Blob passed.
    const call = (navigator.sendBeacon as ReturnType<typeof mock>).mock.calls[0];
    const blob = call[1] as Blob;
    // Blob normalizes the MIME to `<type>;charset=utf-8` when created
    // from a string body; check the leading segment.
    expect(blob.type).toMatch(/^application\/json/);
    const bodyText = await blob.text();
    const parsed = JSON.parse(bodyText);
    expect(parsed.message).toBe("boom");
    expect(parsed.stack).toContain("Error: boom");
    expect(typeof parsed.url).toBe("string");
  });

  it("still logs to console on catch", () => {
    const originalConsoleError = console.error;
    const consoleCalls: unknown[][] = [];
    console.error = mock((...args: unknown[]) => {
      consoleCalls.push(args);
    });
    try {
      const eb = new ErrorBoundary({ children: null });
      eb.componentDidCatch(new Error("logged"), { componentStack: "" } as React.ErrorInfo);
      expect(consoleCalls.length).toBeGreaterThanOrEqual(1);
      expect(String(consoleCalls[0][0])).toContain("React error boundary");
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("swallows sendBeacon throws so the fallback UI still renders", () => {
    // Mid-page-unload or restricted contexts can make sendBeacon throw.
    navigator.sendBeacon = () => {
      throw new Error("sendBeacon rejected");
    };
    const eb = new ErrorBoundary({ children: null });
    expect(() =>
      eb.componentDidCatch(new Error("boundary"), { componentStack: "" } as React.ErrorInfo)
    ).not.toThrow();
  });
});
