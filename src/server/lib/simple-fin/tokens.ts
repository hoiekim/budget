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

/**
 * Private/reserved IPv4 CIDR ranges that must be blocked to prevent SSRF.
 * Includes loopback, link-local, private networks, and cloud metadata endpoints.
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,             // Loopback (127.0.0.0/8)
  /^0\./,               // This network (0.0.0.0/8)
  /^10\./,              // Private network (10.0.0.0/8)
  /^172\.(1[6-9]|2\d|3[01])\./,  // Private network (172.16.0.0/12)
  /^192\.168\./,        // Private network (192.168.0.0/16)
  /^169\.254\./,        // Link-local / AWS metadata (169.254.0.0/16)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // Shared address space (100.64.0.0/10)
  /^::1$/,              // IPv6 loopback
  /^fc00:/,             // IPv6 ULA
  /^fd[0-9a-f]{2}:/,   // IPv6 ULA
  /^fe80:/,             // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",  // GCP metadata
]);

/**
 * Validate that a decoded SimpleFin setup URL is safe to fetch.
 * Prevents SSRF by rejecting non-HTTPS URLs and private/internal destinations.
 *
 * @throws {Error} if the URL is invalid or targets a private/internal host
 */
const validateSetupUrl = (rawUrl: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid SimpleFin setup token: URL is malformed");
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `Invalid SimpleFin setup token: URL must use HTTPS (got ${parsed.protocol})`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Invalid SimpleFin setup token: hostname '${hostname}' is not allowed`
    );
  }

  // Block bare IP addresses that fall in private ranges
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(
        `Invalid SimpleFin setup token: IP address '${hostname}' is in a private/reserved range`
      );
    }
  }

  return parsed;
};

export const exchangeSetupToken = async (setupToken: SetupToken): Promise<AccessUrl> => {
  const rawUrl = Buffer.from(setupToken, "base64").toString();
  const setupUrl = validateSetupUrl(rawUrl); // throws on invalid/private URL
  const response = await fetch(setupUrl.toString(), { method: "POST", headers: { "Content-Length": "0" } });
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
