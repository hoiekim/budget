import { describe, test, expect } from "bun:test";
import {
  createRateLimiter,
  getClientIp,
  loginRateLimiter,
  clientErrorRateLimiter,
  preSessionShedMessage
} from "./rate-limit";

// Each test uses a unique IP so the module-level Map state can't bleed
// between tests. No mocking needed — the pure failure-only API is testable
// directly.
let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter}`;

describe("loginRateLimiter.isLimited", () => {
  test("returns false for a never-seen IP", () => {
    expect(loginRateLimiter.isLimited(nextIp())).toBe(false);
  });

  test("is pure — calling it does not consume a slot", () => {
    const ip = nextIp();
    for (let i = 0; i < 100; i++) loginRateLimiter.isLimited(ip);
    // A subsequent 5 failures should still be allowed (i.e. the 100 checks
    // didn't push us over the limit). The 6th failure exceeds the cap.
    for (let i = 0; i < 5; i++) loginRateLimiter.consume(ip);
    expect(loginRateLimiter.isLimited(ip)).toBe(true);
  });
});

describe("loginRateLimiter.consume / lockout threshold", () => {
  test("5 failures put the IP at the cap, 6th attempt is blocked", () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      loginRateLimiter.consume(ip);
    }
    expect(loginRateLimiter.isLimited(ip)).toBe(true);
  });

  test("4 failures are still under the cap", () => {
    const ip = nextIp();
    for (let i = 0; i < 4; i++) loginRateLimiter.consume(ip);
    expect(loginRateLimiter.isLimited(ip)).toBe(false);
  });
});

describe("successful-login behavior", () => {
  test("a successful login resets the counter so subsequent logins are not blocked", () => {
    const ip = nextIp();
    // 4 failed attempts under the cap, then a success clears the bucket.
    for (let i = 0; i < 4; i++) loginRateLimiter.consume(ip);
    loginRateLimiter.reset(ip);
    // Should now tolerate another 5 failures before locking out.
    for (let i = 0; i < 5; i++) loginRateLimiter.consume(ip);
    expect(loginRateLimiter.isLimited(ip)).toBe(true);
  });

  test("simulating 6 successful logins in a row — the bug repro — never blocks", () => {
    // In the buggy code each "success" was implicitly a check-and-bump:
    // 5 bumps → the 6th request was 429'd. With failure-only counting,
    // successes simply don't touch the counter, so this loop never blocks.
    const ip = nextIp();
    for (let i = 0; i < 6; i++) {
      expect(loginRateLimiter.isLimited(ip)).toBe(false);
      // Success path: reset is the only state change.
      loginRateLimiter.reset(ip);
    }
  });
});

describe("loginRateLimiter.reset", () => {
  test("clears a locked-out IP", () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) loginRateLimiter.consume(ip);
    expect(loginRateLimiter.isLimited(ip)).toBe(true);
    loginRateLimiter.reset(ip);
    expect(loginRateLimiter.isLimited(ip)).toBe(false);
  });

  test("is safe to call on an unknown IP", () => {
    expect(() => loginRateLimiter.reset(nextIp())).not.toThrow();
  });
});
describe("bucket isolation", () => {
  test("filling one limiter leaves a different limiter's quota untouched for the same IP", () => {
    // A chatty endpoint must not be able to lock an IP out of the login path
    // (or vice versa) by exhausting a shared counter.
    const ip = nextIp();
    const noisy = createRateLimiter("noisy-bucket", { maxAttempts: 2, windowMs: 60_000 });
    const quiet = createRateLimiter("quiet-bucket", { maxAttempts: 2, windowMs: 60_000 });

    for (let i = 0; i < 10; i++) noisy.consume(ip);

    expect(noisy.isLimited(ip)).toBe(true);
    expect(quiet.isLimited(ip)).toBe(false);
    expect(loginRateLimiter.isLimited(ip)).toBe(false);
  });

  test("resetting one limiter does not clear another's counters", () => {
    const ip = nextIp();
    const a = createRateLimiter("reset-bucket-a", { maxAttempts: 1, windowMs: 60_000 });
    const b = createRateLimiter("reset-bucket-b", { maxAttempts: 1, windowMs: 60_000 });

    a.consume(ip);
    b.consume(ip);
    a.reset(ip);

    expect(a.isLimited(ip)).toBe(false);
    expect(b.isLimited(ip)).toBe(true);
  });

  test("two limiters sharing a bucket name share counters", () => {
    // Documents the contract: isolation comes from the bucket string, not from
    // the factory call, so bucket names must be unique per limiter.
    const ip = nextIp();
    const first = createRateLimiter("same-bucket", { maxAttempts: 1, windowMs: 60_000 });
    const second = createRateLimiter("same-bucket", { maxAttempts: 1, windowMs: 60_000 });

    first.consume(ip);

    expect(second.isLimited(ip)).toBe(true);
  });

  test("each limiter enforces its own maxAttempts", () => {
    const ip = nextIp();
    const strict = createRateLimiter("strict-bucket", { maxAttempts: 1, windowMs: 60_000 });
    const lenient = createRateLimiter("lenient-bucket", { maxAttempts: 5, windowMs: 60_000 });

    strict.consume(ip);
    lenient.consume(ip);

    expect(strict.isLimited(ip)).toBe(true);
    expect(lenient.isLimited(ip)).toBe(false);
  });

  test("a window that has elapsed starts a fresh count", async () => {
    const ip = nextIp();
    const brief = createRateLimiter("brief-bucket", { maxAttempts: 2, windowMs: 20 });

    brief.consume(ip);
    brief.consume(ip);
    expect(brief.isLimited(ip)).toBe(true);

    await Bun.sleep(30);
    expect(brief.isLimited(ip)).toBe(false);

    // The new window must carry a fresh count, not a resumed one: if the
    // expired record were incremented in place its resetAt would stay in the
    // past and the IP would never be limited again.
    brief.consume(ip);
    expect(brief.isLimited(ip)).toBe(false);
    brief.consume(ip);
    expect(brief.isLimited(ip)).toBe(true);
  });
});

describe("remaining", () => {
  test("reports the full quota before anything is consumed", () => {
    const limiter = createRateLimiter("remaining-fresh", { maxAttempts: 3, windowMs: 60_000 });
    expect(limiter.remaining("k")).toBe(3);
  });

  test("counts down with each consumed slot and floors at zero", () => {
    const limiter = createRateLimiter("remaining-countdown", { maxAttempts: 3, windowMs: 60_000 });
    limiter.consume("k");
    expect(limiter.remaining("k")).toBe(2);
    limiter.consume("k", 5);
    expect(limiter.remaining("k")).toBe(0);
    expect(limiter.isLimited("k")).toBe(true);
  });

  test("returns the full quota again once the window has expired", async () => {
    const limiter = createRateLimiter("remaining-expiry", { maxAttempts: 2, windowMs: 20 });
    limiter.consume("k", 2);
    expect(limiter.remaining("k")).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(limiter.remaining("k")).toBe(2);
  });

  test("is read-only — reading it does not charge the quota", () => {
    const limiter = createRateLimiter("remaining-readonly", { maxAttempts: 2, windowMs: 60_000 });
    limiter.remaining("k");
    limiter.remaining("k");
    limiter.remaining("k");
    expect(limiter.remaining("k")).toBe(2);
    expect(limiter.isLimited("k")).toBe(false);
  });

  test("tracks each key separately", () => {
    const limiter = createRateLimiter("remaining-per-key", { maxAttempts: 4, windowMs: 60_000 });
    limiter.consume("a", 3);
    expect(limiter.remaining("a")).toBe(1);
    expect(limiter.remaining("b")).toBe(4);
  });
});

describe("consume with a slot count", () => {
  test("a multi-slot charge crosses the threshold in one call", () => {
    const limiter = createRateLimiter("slots-threshold", { maxAttempts: 5, windowMs: 60_000 });
    limiter.consume("k", 5);
    expect(limiter.isLimited("k")).toBe(true);
  });

  test("a multi-slot charge on a fresh key opens the window at that count", () => {
    const limiter = createRateLimiter("slots-fresh-window", { maxAttempts: 5, windowMs: 60_000 });
    limiter.consume("k", 4);
    expect(limiter.remaining("k")).toBe(1);
  });

  test("defaults to one slot so existing callers are unchanged", () => {
    const limiter = createRateLimiter("slots-default", { maxAttempts: 3, windowMs: 60_000 });
    limiter.consume("k");
    limiter.consume("k");
    expect(limiter.remaining("k")).toBe(1);
    expect(limiter.isLimited("k")).toBe(false);
  });
});

describe("preSessionShedMessage", () => {
  test("sheds POST /login once the IP is over the login cap", () => {
    const ip = nextIp();
    expect(preSessionShedMessage("POST", "/login", ip)).toBeNull();

    for (let i = 0; i < 5; i++) loginRateLimiter.consume(ip);

    expect(preSessionShedMessage("POST", "/login", ip)).toBe(
      "Too many login attempts, try again later",
    );
  });

  test("sheds POST /client-error once the IP is over the client-error cap", () => {
    const ip = nextIp();
    expect(preSessionShedMessage("POST", "/client-error", ip)).toBeNull();

    for (let i = 0; i < 12; i++) clientErrorRateLimiter.consume(ip);

    expect(preSessionShedMessage("POST", "/client-error", ip)).toBe(
      "Too many client error reports, try again later",
    );
  });

  test("the two entries shed independently for the same IP", () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) loginRateLimiter.consume(ip);

    expect(preSessionShedMessage("POST", "/login", ip)).not.toBeNull();
    expect(preSessionShedMessage("POST", "/client-error", ip)).toBeNull();
  });

  test("both the method and the path have to match", () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) loginRateLimiter.consume(ip);

    expect(preSessionShedMessage("GET", "/login", ip)).toBeNull();
    expect(preSessionShedMessage("POST", "/logout", ip)).toBeNull();
    expect(preSessionShedMessage("POST", "/transactions", ip)).toBeNull();
  });
});

describe("getClientIp tier precedence", () => {
  test("falls back to the socket address when neither proxy header is set", () => {
    expect(getClientIp({}, "10.0.0.7")).toBe("10.0.0.7");
  });

  test("X-Real-IP wins over both the forwarded chain and the socket", () => {
    const headers = { "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.8" };
    expect(getClientIp(headers, "10.0.0.7")).toBe("203.0.113.9");
  });

  test("the leftmost X-Forwarded-For entry wins over the socket", () => {
    const headers = { "x-forwarded-for": "203.0.113.8, 10.0.0.1, 10.0.0.2" };
    expect(getClientIp(headers, "10.0.0.7")).toBe("203.0.113.8");
  });

  test("an array-valued X-Forwarded-For takes its first entry", () => {
    const headers = { "x-forwarded-for": ["203.0.113.8", "10.0.0.1"] };
    expect(getClientIp(headers, "10.0.0.7")).toBe("203.0.113.8");
  });

  test("a non-string X-Real-IP is skipped rather than stringified", () => {
    const headers = { "x-real-ip": ["203.0.113.9"] };
    expect(getClientIp(headers, "10.0.0.7")).toBe("10.0.0.7");
  });

  test("'unknown' is reached only when every tier is absent", () => {
    expect(getClientIp({}, undefined)).toBe("unknown");
  });
});

describe("getClientIp keys the pre-session limiters per socket", () => {
  const nextSocket = () => `192.0.2.${++ipCounter}`;

  test("two header-less clients on different sockets resolve to different keys", () => {
    const a = getClientIp({}, nextSocket());
    const b = getClientIp({}, nextSocket());

    expect(a).not.toBe(b);
    expect(a).not.toBe("unknown");
    expect(b).not.toBe("unknown");
  });

  test("five failed logins from one socket do not shed POST /login for another", () => {
    const attacker = getClientIp({}, nextSocket());
    const victim = getClientIp({}, nextSocket());

    for (let i = 0; i < 5; i++) loginRateLimiter.consume(attacker);

    expect(preSessionShedMessage("POST", "/login", attacker)).toBe(
      "Too many login attempts, try again later",
    );
    expect(preSessionShedMessage("POST", "/login", victim)).toBeNull();
  });

  test("a successful login from one socket does not clear another's counter", () => {
    const attacker = getClientIp({}, nextSocket());
    const bystander = getClientIp({}, nextSocket());

    for (let i = 0; i < 5; i++) loginRateLimiter.consume(attacker);
    loginRateLimiter.reset(bystander);

    expect(preSessionShedMessage("POST", "/login", attacker)).toBe(
      "Too many login attempts, try again later",
    );
  });
});
