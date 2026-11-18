import { createAuthClient, type AuthClient, type AuthClientOptions } from "server/lib/auth-client";
import { parseSsoConfig, readSsoEnv, type SsoConfig } from "server/lib/sso/config";
import { AUTH_CALLBACK_PATH, AUTH_EVENTS_PATH, AUTH_LOGIN_PATH } from "server/lib/sso/paths";

export interface Sso {
  config: SsoConfig;
  client: AuthClient;
}

/** How people sign in, as the sign-in page needs to know before anyone has. */
export interface SsoMode {
  enabled: boolean;
  /** The app's own password sign-in is offered. */
  localLogin: boolean;
}

let sso: Sso | null = null;

/** `null` while single sign-on is off. */
export const getSso = (): Sso | null => sso;

/** Replaces the running configuration. `clientOptions` lets a test reach a fake issuer. */
export const configureSso = (
  config: SsoConfig | null,
  clientOptions: Pick<AuthClientOptions, "fetch" | "now"> = {},
): void => {
  sso = config && {
    config,
    client: createAuthClient({
      issuer: config.issuer,
      backChannelUrl: config.backChannelUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      audience: config.audience,
      ...clientOptions,
    }),
  };
};

/** Reads the environment at boot; throws an `SsoConfigError` naming every problem. */
export const initializeSso = (): void => configureSso(parseSsoConfig(readSsoEnv()));

export const ssoMode = (): SsoMode => ({
  enabled: sso !== null,
  localLogin: sso?.config.localLogin ?? true,
});

const SSO_PUBLIC_PATH_METHODS: [string, Set<string>][] = [
  [AUTH_LOGIN_PATH, new Set(["GET"])],
  [AUTH_CALLBACK_PATH, new Set(["GET"])],
  [AUTH_EVENTS_PATH, new Set(["POST"])],
];

/** The routes that answer anyone while single sign-on is on; while it is off there are none. */
export const ssoPublicPathMethods = (): [string, Set<string>][] =>
  sso ? SSO_PUBLIC_PATH_METHODS : [];
