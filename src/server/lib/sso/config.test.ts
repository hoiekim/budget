import { describe, test, expect } from "bun:test";
import { parseSsoConfig, SsoConfigError, type SsoEnv } from "./config";

const VALID: SsoEnv = {
  AUTH_ISSUER: "https://auth.example.com",
  AUTH_CLIENT_ID: "budget",
  AUTH_CLIENT_SECRET: "s3cret",
  HOST_NAME: "budget.example.com",
};

const problemsOf = (env: SsoEnv): string[] => {
  try {
    parseSsoConfig(env);
  } catch (error) {
    if (error instanceof SsoConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected an SsoConfigError");
};

describe("parseSsoConfig", () => {
  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("an AUTH_ISSUER that is %s turns single sign-on off, whatever else is set", (_, issuer) => {
    expect(
      parseSsoConfig({ AUTH_ISSUER: issuer, AUTH_CLIENT_ID: "", AUTH_LOCAL_LOGIN: "maybe" }),
    ).toBeNull();
  });

  test("a complete configuration, with the defaults filled in", () => {
    expect(parseSsoConfig(VALID)).toEqual({
      issuer: "https://auth.example.com",
      clientId: "budget",
      clientSecret: "s3cret",
      redirectUri: "https://budget.example.com/api/auth/callback",
      backChannelUrl: undefined,
      audience: undefined,
      localLogin: false,
      linkUsers: new Map(),
      postLogoutRedirect: "https://budget.example.com/",
    });
  });

  test("an explicit redirect URI wins over HOST_NAME, and its origin is the post-logout redirect", () => {
    const config = parseSsoConfig({
      ...VALID,
      AUTH_REDIRECT_URI: "https://money.example.com:8443/api/auth/callback",
      AUTH_BACKCHANNEL_URL: "http://auth.internal:3000",
      AUTH_AUDIENCE: "budget-service",
    });
    expect(config?.redirectUri).toBe("https://money.example.com:8443/api/auth/callback");
    expect(config?.postLogoutRedirect).toBe("https://money.example.com:8443/");
    expect(config?.backChannelUrl).toBe("http://auth.internal:3000");
    expect(config?.audience).toBe("budget-service");
  });

  test("the redirect URI is required when HOST_NAME is unset", () => {
    expect(problemsOf({ ...VALID, HOST_NAME: undefined })).toEqual([
      "AUTH_REDIRECT_URI is required when HOST_NAME is not set",
    ]);
  });

  test.each(["https://budget.example.com", "budget.example.com/app"])(
    "a HOST_NAME of %s cannot make a redirect URI",
    (hostName) => {
      expect(problemsOf({ ...VALID, HOST_NAME: hostName })).toEqual([
        "HOST_NAME must be a bare host name to derive AUTH_REDIRECT_URI from it; otherwise set AUTH_REDIRECT_URI",
      ]);
    },
  );

  test.each([
    ["true", true],
    ["1", true],
    ["YES", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["", false],
    [undefined, false],
  ])("AUTH_LOCAL_LOGIN=%p reads as %p", (raw, expected) => {
    expect(parseSsoConfig({ ...VALID, AUTH_LOCAL_LOGIN: raw })?.localLogin).toBe(expected);
  });

  test("AUTH_LINK_USERS maps each SSO username to its local account", () => {
    const config = parseSsoConfig({ ...VALID, AUTH_LINK_USERS: " admin = alice, bob=bob ," });
    expect([...(config?.linkUsers ?? [])]).toEqual([
      ["alice", "admin"],
      ["bob", "bob"],
    ]);
  });

  test("every problem is listed at once, and the secret never appears in them", () => {
    const problems = problemsOf({
      AUTH_ISSUER: "http://auth.example.com",
      AUTH_CLIENT_SECRET: "do-not-print",
      AUTH_REDIRECT_URI: "/api/auth/callback",
      AUTH_BACKCHANNEL_URL: "ftp://auth.internal",
      AUTH_LOCAL_LOGIN: "sometimes",
      AUTH_LINK_USERS: "admin,=bob,carol=dave=erin,ann=al ice,x=alice,y=alice,x=zed",
    });
    expect(problems).toEqual([
      "AUTH_ISSUER must be an https URL (http only for localhost) with no query or fragment",
      "AUTH_CLIENT_ID is required when AUTH_ISSUER is set",
      "AUTH_REDIRECT_URI must be an https URL (http only for localhost) with no fragment",
      "AUTH_BACKCHANNEL_URL must be an http or https URL with no query or fragment",
      "AUTH_LOCAL_LOGIN must be true or false",
      'AUTH_LINK_USERS entry "admin" is not of the form <local account>=<auth username>',
      'AUTH_LINK_USERS entry "=bob" is not of the form <local account>=<auth username>',
      'AUTH_LINK_USERS entry "carol=dave=erin" is not of the form <local account>=<auth username>',
      'AUTH_LINK_USERS entry "ann=al ice" is not of the form <local account>=<auth username>',
      'AUTH_LINK_USERS names auth username "alice" more than once',
      'AUTH_LINK_USERS names local account "x" more than once',
    ]);
    expect(problems.join("\n")).not.toContain("do-not-print");
  });

  test("the error message lists the problems", () => {
    expect(() => parseSsoConfig({ ...VALID, AUTH_CLIENT_SECRET: "" })).toThrow(
      "Single sign-on is misconfigured:\n- AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set",
    );
  });

  test.each([
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://[::1]:4000",
    "https://auth.example.com/tenant",
  ])("accepts issuer %s", (issuer) => {
    expect(parseSsoConfig({ ...VALID, AUTH_ISSUER: issuer })?.issuer).toBe(issuer);
  });

  test.each(["https://auth.example.com/?x=1", "https://auth.example.com/#x", "not a url"])(
    "refuses issuer %s",
    (issuer) => {
      expect(problemsOf({ ...VALID, AUTH_ISSUER: issuer })).toEqual([
        "AUTH_ISSUER must be an https URL (http only for localhost) with no query or fragment",
      ]);
    },
  );
});
