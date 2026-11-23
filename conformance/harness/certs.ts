/**
 * A throwaway certificate authority and one server certificate for the hosts
 * the servers call out to (Plaid, Polygon, Yahoo, BLS, Discord, a SimpleFin
 * bridge). The intercepting proxy presents the certificate; each server under
 * test is told to trust the authority. Made with the `openssl` command on
 * first use and kept in the temp directory, so no key lives in the repository.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every host the fake upstreams answer for. A host missing here fails its TLS handshake. */
export const UPSTREAM_HOSTS = [
  "production.plaid.com",
  "development.plaid.com",
  "sandbox.plaid.com",
  "api.polygon.io",
  "query1.finance.yahoo.com",
  "api.bls.gov",
  "discord.com",
  "bridge.simplefin.test",
  "claim.simplefin.test",
  "other.simplefin.test",
  "auth.example.test",
] as const;

export interface Certs {
  /** PEM file of the certificate authority, for the servers to trust. */
  caPath: string;
  certPath: string;
  keyPath: string;
}

const MAX_AGE_MS = 20 * 24 * 60 * 60 * 1000;
const VERSION = `v2-${UPSTREAM_HOSTS.length}`;

const run = (args: string[], cwd: string): void => {
  const result = Bun.spawnSync(["openssl", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${result.stderr.toString()}`);
  }
};

const generate = (dir: string): void => {
  run(
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "30",
      "-subj", "/CN=budget-conformance-ca",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
    dir,
  );
  run(
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=budget-conformance-upstreams"],
    dir,
  );
  fs.writeFileSync(
    path.join(dir, "ext.cnf"),
    [
      `subjectAltName=${UPSTREAM_HOSTS.map((host) => `DNS:${host}`).join(",")}`,
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
  );
  run(
    ["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt",
      "-days", "30", "-extfile", "ext.cnf"],
    dir,
  );
};

let cached: Certs | undefined;

export const ensureCerts = (): Certs => {
  if (cached) return cached;
  const dir = path.join(os.tmpdir(), `budget-conformance-certs-${process.getuid?.() ?? "user"}-${VERSION}`);
  const certsOf = (base: string): Certs => ({
    caPath: path.join(base, "ca.crt"),
    certPath: path.join(base, "leaf.crt"),
    keyPath: path.join(base, "leaf.key"),
  });
  const fresh = (): boolean => {
    try {
      return Date.now() - fs.statSync(path.join(dir, "leaf.crt")).mtimeMs < MAX_AGE_MS;
    } catch {
      return false;
    }
  };
  if (!fresh()) {
    // Built aside and renamed into place, so two suites starting together
    // never read a half-written set. A set another suite put in place
    // meanwhile is kept: its servers already trust that authority, and
    // replacing it would leave them trusting one the proxy no longer presents.
    const building = fs.mkdtempSync(`${dir}-building-`);
    generate(building);
    if (fresh()) {
      fs.rmSync(building, { recursive: true, force: true });
    } else {
      // Move a stale set aside rather than delete it in place: the rename is
      // atomic, so the directory is never seen half-removed.
      if (fs.existsSync(dir)) {
        const stale = `${dir}-stale-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(dir, stale);
          fs.rmSync(stale, { recursive: true, force: true });
        } catch {
          // Another process moved it first.
        }
      }
      try {
        fs.renameSync(building, dir);
      } catch {
        // Another process won the rename; its set is as good as ours.
        fs.rmSync(building, { recursive: true, force: true });
      }
    }
  }
  cached = certsOf(dir);
  return cached;
};
