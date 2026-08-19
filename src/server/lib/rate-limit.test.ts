import { describe, test, expect } from "bun:test";
import { createRateLimiter, loginRateLimiter } from "./rate-limit";

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
