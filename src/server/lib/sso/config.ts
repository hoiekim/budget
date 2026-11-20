import { AUTH_CALLBACK_PATH } from "server/lib/sso/paths";

export interface SsoConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  backChannelUrl?: string;
  audience?: string;
  /** Keep the app's own password sign-in next to single sign-on. */
  localLogin: boolean;
  /** Local account to link on first sign-in, keyed by the identity provider's username. */
  linkUsers: Map<string, string>;
  /** Where the identity provider sends the browser after signing out. */
  postLogoutRedirect: string;
}

export interface SsoEnv {
  AUTH_ISSUER?: string;
  AUTH_CLIENT_ID?: string;
  AUTH_CLIENT_SECRET?: string;
  AUTH_REDIRECT_URI?: string;
  AUTH_BACKCHANNEL_URL?: string;
  AUTH_AUDIENCE?: string;
  AUTH_LOCAL_LOGIN?: string;
  AUTH_LINK_USERS?: string;
  HOST_NAME?: string;
}

export const readSsoEnv = (): SsoEnv => ({
  AUTH_ISSUER: process.env.AUTH_ISSUER,
  AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID,
  AUTH_CLIENT_SECRET: process.env.AUTH_CLIENT_SECRET,
  AUTH_REDIRECT_URI: process.env.AUTH_REDIRECT_URI,
  AUTH_BACKCHANNEL_URL: process.env.AUTH_BACKCHANNEL_URL,
  AUTH_AUDIENCE: process.env.AUTH_AUDIENCE,
  AUTH_LOCAL_LOGIN: process.env.AUTH_LOCAL_LOGIN,
  AUTH_LINK_USERS: process.env.AUTH_LINK_USERS,
  HOST_NAME: process.env.HOST_NAME,
});

export class SsoConfigError extends Error {
  override name = "SsoConfigError";

  constructor(readonly problems: string[]) {
    super(`Single sign-on is misconfigured:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

const nonEmpty = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
};

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

/** An https URL, or http on a loopback host, the way the identity provider registers them. */
const isSecureUrl = (url: URL): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));

const checkIssuer = (raw: string, problems: string[]): void => {
  const url = parseUrl(raw);
  if (!url || !isSecureUrl(url) || url.search || url.hash) {
    problems.push(
      "AUTH_ISSUER must be an https URL (http only for localhost) with no query or fragment",
    );
  }
};

const checkBackChannelUrl = (raw: string | undefined, problems: string[]): void => {
  if (raw === undefined) return;
  const url = parseUrl(raw);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    problems.push("AUTH_BACKCHANNEL_URL must be an http or https URL with no query or fragment");
  }
};

const redirectUriOf = (env: SsoEnv, problems: string[]): string | undefined => {
  const explicit = nonEmpty(env.AUTH_REDIRECT_URI);
  if (explicit !== undefined) {
    const url = parseUrl(explicit);
    if (!url || !isSecureUrl(url) || url.hash) {
      problems.push(
        "AUTH_REDIRECT_URI must be an https URL (http only for localhost) with no fragment",
      );
      return undefined;
    }
    return explicit;
  }
  const hostName = nonEmpty(env.HOST_NAME);
  if (hostName === undefined) {
    problems.push("AUTH_REDIRECT_URI is required when HOST_NAME is not set");
    return undefined;
  }
  const derived = parseUrl(`https://${hostName}/api${AUTH_CALLBACK_PATH}`);
  if (!derived || derived.host !== hostName.toLowerCase()) {
    problems.push(
      "HOST_NAME must be a bare host name to derive AUTH_REDIRECT_URI from it; otherwise set AUTH_REDIRECT_URI",
    );
    return undefined;
  }
  return derived.toString();
};

const parseLocalLogin = (raw: string | undefined, problems: string[]): boolean => {
  const value = nonEmpty(raw)?.toLowerCase();
  if (value === undefined || FALSE_VALUES.has(value)) return false;
  if (TRUE_VALUES.has(value)) return true;
  problems.push("AUTH_LOCAL_LOGIN must be true or false");
  return false;
};

const parseLinkUsers = (raw: string | undefined, problems: string[]): Map<string, string> => {
  const links = new Map<string, string>();
  const localAccounts = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("=").map((part) => part.trim());
    const [localAccount, authUsername] = parts;
    if (parts.length !== 2 || !localAccount || !authUsername || /\s/.test(parts.join(""))) {
      problems.push(
        `AUTH_LINK_USERS entry "${trimmed}" is not of the form <local account>=<auth username>`,
      );
    } else if (links.has(authUsername)) {
      problems.push(`AUTH_LINK_USERS names auth username "${authUsername}" more than once`);
    } else if (localAccounts.has(localAccount)) {
      problems.push(`AUTH_LINK_USERS names local account "${localAccount}" more than once`);
    } else {
      links.set(authUsername, localAccount);
      localAccounts.add(localAccount);
    }
  }
  return links;
};

/**
 * Single sign-on's settings, or `null` when `AUTH_ISSUER` is unset or empty,
 * which turns the feature off. Throws an `SsoConfigError` naming every
 * problem at once. Reads nothing over the network.
 */
export const parseSsoConfig = (env: SsoEnv): SsoConfig | null => {
  const issuer = nonEmpty(env.AUTH_ISSUER);
  if (issuer === undefined) return null;

  const problems: string[] = [];
  checkIssuer(issuer, problems);
  const clientId = nonEmpty(env.AUTH_CLIENT_ID);
  if (clientId === undefined) problems.push("AUTH_CLIENT_ID is required when AUTH_ISSUER is set");
  const clientSecret = nonEmpty(env.AUTH_CLIENT_SECRET);
  if (clientSecret === undefined) {
    problems.push("AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set");
  }
  const redirectUri = redirectUriOf(env, problems);
  const backChannelUrl = nonEmpty(env.AUTH_BACKCHANNEL_URL);
  checkBackChannelUrl(backChannelUrl, problems);
  const localLogin = parseLocalLogin(env.AUTH_LOCAL_LOGIN, problems);
  const linkUsers = parseLinkUsers(env.AUTH_LINK_USERS, problems);

  if (problems.length > 0 || !clientId || !clientSecret || !redirectUri) {
    throw new SsoConfigError(problems);
  }

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    backChannelUrl,
    audience: nonEmpty(env.AUTH_AUDIENCE),
    localLogin,
    linkUsers,
    postLogoutRedirect: `${new URL(redirectUri).origin}/`,
  };
};
