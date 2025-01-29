/**
 * https://www.simplefin.org/protocol.html
 */

/**
 * Provided by SimpleFin. Basically a URL encoded with base64
 * @example "aG3ibNg58cM..."
 */
type SetupToken = string;

/**
 * You get this when exchanging setup URL.
 * @example "https://123ABC:123ABC@beta-bridge.simplefin.org/simplefin"
 */
type AccessUrl = string;

export const exchangeSetupToken = async (setupToken: SetupToken): Promise<AccessUrl> => {
  const setupUrl = Buffer.from(setupToken, "base64").toString();
  const response = await fetch(setupUrl, { method: "POST", headers: { "Content-Length": "0" } });
  return await response.text();
};

interface SimpleFinCredentials {
  url: string;
  credentials: string;
}

export const decodeAccessUrl = (accessUrl: AccessUrl): SimpleFinCredentials => {
  const [scheme, rest] = accessUrl.split("://");
  const [auth, rest2] = rest.split("@");
  const url = `${scheme}://${rest2}`;
  const [username, password] = auth.split(":");
  const credentials = Buffer.from(`${username}:${password}`).toString("base64");
  return { url, credentials };
};
