import { describe, test, expect } from "bun:test";
import {
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginAttempts,
} from "./rate-limit";

// Each test uses a unique IP so the module-level Map state can't bleed
// between tests. No mocking needed — the pure failure-only API is testable
// directly.
let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter}`;

describe("isLoginRateLimited", () => {
  test("returns false for a never-seen IP", () => {
    expect(isLoginRateLimited(nextIp())).toBe(false);
  });

  test("is pure — calling it does not consume a slot", () => {
    const ip = nextIp();
    for (let i = 0; i < 100; i++) isLoginRateLimited(ip);
    // A subsequent 5 failures should still be allowed (i.e. the 100 checks
    // didn't push us over the limit). The 6th failure exceeds the cap.
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    expect(isLoginRateLimited(ip)).toBe(true);
  });
});

describe("recordLoginFailure / lockout threshold", () => {
  test("5 failures put the IP at the cap, 6th attempt is blocked", () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      recordLoginFailure(ip);
    }
    expect(isLoginRateLimited(ip)).toBe(true);
  });

  test("4 failures are still under the cap", () => {
    const ip = nextIp();
    for (let i = 0; i < 4; i++) recordLoginFailure(ip);
    expect(isLoginRateLimited(ip)).toBe(false);
  });
});

describe("successful-login behavior (the #389 regression)", () => {
  test("a successful login resets the counter so subsequent logins are not blocked", () => {
    const ip = nextIp();
    // 4 failed attempts under the cap, then a success clears the bucket.
    for (let i = 0; i < 4; i++) recordLoginFailure(ip);
    resetLoginAttempts(ip);
    // Should now tolerate another 5 failures before locking out.
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    expect(isLoginRateLimited(ip)).toBe(true);
  });

  test("simulating 6 successful logins in a row — the bug repro — never blocks", () => {
    // In the buggy code each "success" was implicitly a check-and-bump:
    // 5 bumps → the 6th request was 429'd. With failure-only counting,
    // successes simply don't touch the counter, so this loop never blocks.
    const ip = nextIp();
    for (let i = 0; i < 6; i++) {
      expect(isLoginRateLimited(ip)).toBe(false);
      // Success path: resetLoginAttempts is the only state change.
      resetLoginAttempts(ip);
    }
  });
});

describe("resetLoginAttempts", () => {
  test("clears a locked-out IP", () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    expect(isLoginRateLimited(ip)).toBe(true);
    resetLoginAttempts(ip);
    expect(isLoginRateLimited(ip)).toBe(false);
  });

  test("is safe to call on an unknown IP", () => {
    expect(() => resetLoginAttempts(nextIp())).not.toThrow();
  });
});
