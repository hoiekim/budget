import { describe, test, expect, afterAll } from "bun:test";
import { startFakeIssuer } from "test-issuer";
import { configureSso, getSso, ssoMode, ssoPublicPathMethods } from "./state";

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
});

describe("single sign-on state", () => {
  test("off: password sign-in only, and no public single sign-on route", () => {
    configureSso(null);
    expect(getSso()).toBeNull();
    expect(ssoMode()).toEqual({ enabled: false, localLogin: true });
    expect(ssoPublicPathMethods()).toEqual([]);
  });

  test.each([
    [false, { enabled: true, localLogin: false }],
    [true, { enabled: true, localLogin: true }],
  ])("on with AUTH_LOCAL_LOGIN=%p", (localLogin, mode) => {
    configureSso(issuer.config({ localLogin }));
    expect(ssoMode()).toEqual(mode);
  });

  test("on: the login and callback routes take GET, the events route POST, from anyone", () => {
    configureSso(issuer.config());
    expect(ssoPublicPathMethods()).toEqual([
      ["/auth/login", new Set(["GET"])],
      ["/auth/callback", new Set(["GET"])],
      ["/auth/events", new Set(["POST"])],
    ]);
  });

  test("configuring contacts no one", () => {
    issuer.reset();
    configureSso(issuer.config(), { fetch: issuer.fetch });
    expect(issuer.state.seen).toEqual([]);
  });
});
