/**
 * One started server and everything around it: an empty database, the
 * intercepted upstreams, and clients to drive it. A test file starts one (or
 * several, when it needs different settings) and stops each when done.
 *
 *   let stack: Stack;
 *   beforeAll(async () => { stack = await startStack(); });
 *   afterAll(() => stack.stop());
 */
import net from "node:net";
import {
  ADMIN_PASSWORD,
  CLIENT_DIR,
  DEMO_PASSWORD,
  HOST_NAME,
  POSTGRES,
  REPO_ROOT,
  TARGET,
  VERBOSE,
  serverCommand,
} from "./config";
import { ApiClient } from "./client";
import { Database } from "./postgres";
import { callerTestFile, flush, record } from "./transcript";
import { UpstreamHub } from "./upstreams/hub";
import { FakeIssuer } from "./upstreams/issuer";
import { DISCORD_WEBHOOK_URL, FakeDiscord } from "./upstreams/discord";
import { FakeBls } from "./upstreams/bls";
import { FakePlaid } from "./upstreams/plaid";
import { FakeSimpleFin } from "./upstreams/simplefin";
import { FakePolygon } from "./upstreams/polygon";
import { FakeYahoo } from "./upstreams/yahoo";

export interface StackOptions {
  /** Extra environment for the server; `undefined` removes a default. */
  env?: Record<string, string | undefined>;
  /** Turn single sign-on on against the fake identity provider, with these `AUTH_*` overrides. */
  sso?: Record<string, string> | boolean;
  /** Run before the server starts, with the empty database: seed rows a boot-time job should find. */
  beforeStart?: (stack: Stack) => Promise<void> | void;
  /** Do not wait for the first scheduled sync to finish before returning. */
  skipSyncWait?: boolean;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fileStackCounts = new Map<string, number>();

/** Request headers worth comparing between the two servers' upstream calls. */
const UPSTREAM_HEADERS = ["authorization", "plaid-client-id", "plaid-secret", "x-real-ip", "content-type"];

export class Stack {
  readonly logs: string[] = [];
  readonly upstream: {
    hub: UpstreamHub;
    issuer: FakeIssuer;
    discord: FakeDiscord;
    bls: FakeBls;
    plaid: FakePlaid;
    simplefin: FakeSimpleFin;
    polygon: FakePolygon;
    yahoo: FakeYahoo;
  };
  port = 0;
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private env: Record<string, string> = {};
  private stopped = false;
  private upstreamRecorded = 0;

  private constructor(
    readonly db: Database,
    hub: UpstreamHub,
    private readonly file: string,
    private readonly index: number,
  ) {
    this.upstream = {
      hub,
      issuer: new FakeIssuer(hub),
      discord: new FakeDiscord(hub),
      bls: new FakeBls(hub),
      plaid: new FakePlaid(hub),
      simplefin: new FakeSimpleFin(hub),
      polygon: new FakePolygon(hub),
      yahoo: new FakeYahoo(hub),
    };
  }

  static async start(options: StackOptions = {}, file = callerTestFile()): Promise<Stack> {
    const index = fileStackCounts.get(file) ?? 0;
    fileStackCounts.set(file, index + 1);
    const [db, hub] = await Promise.all([Database.create(file.replace(/\.test\.ts$/, "")), UpstreamHub.start()]);
    const stack = new Stack(db, hub, file, index);
    try {
      stack.port = await freePort();
      stack.env = stack.buildEnv(options);
      await options.beforeStart?.(stack);
      await stack.spawn();
      if (!options.skipSyncWait) await stack.waitForLog("Scheduled sync completed");
    } catch (error) {
      await stack.stop();
      throw error;
    }
    return stack;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private buildEnv(options: StackOptions): Record<string, string> {
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TZ: process.env.TZ ?? "UTC",
      PORT: String(this.port),
      HOST_NAME,
      ADMIN_PASSWORD,
      DEMO_PASSWORD,
      POSTGRES_HOST: POSTGRES.host,
      POSTGRES_PORT: String(POSTGRES.port),
      POSTGRES_USER: POSTGRES.user,
      POSTGRES_PASSWORD: POSTGRES.password,
      POSTGRES_DATABASE: this.db.name,
      PLAID_CLIENT_ID: "conformance-plaid-client",
      PLAID_SECRET_PRODUCTION: "conformance-plaid-production",
      PLAID_SECRET_DEVELOPMENT: "conformance-plaid-development",
      PLAID_SECRET_SANDBOX: "conformance-plaid-sandbox",
      POLYGON_API_KEY: "conformance-polygon-key",
      // The upstreams are fakes, so the politeness gates would only slow tests down.
      POLYGON_RATE_LIMIT_PER_MIN: "0",
      YAHOO_RATE_LIMIT_PER_MIN: "0",
      DISCORD_ALARM_WEBHOOK: DISCORD_WEBHOOK_URL,
      LOG_LEVEL: "info",
      // Outbound HTTPS goes to the fakes; the database and the identity
      // provider's back channel are reached directly.
      HTTPS_PROXY: this.upstream.hub.proxyUrl,
      https_proxy: this.upstream.hub.proxyUrl,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: this.upstream.hub.caPath,
      SSL_CERT_FILE: this.upstream.hub.caPath,
      // Read by the Rust server only; the Bun server serves the same directory by its own layout.
      CLIENT_DIR,
    };
    if (options.sso) {
      Object.assign(env, this.upstream.issuer.env(options.sso === true ? {} : options.sso));
    }
    Object.assign(env, options.env);
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) cleaned[key] = value;
    return cleaned;
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        this.logs.push(line);
        if (VERBOSE) console.log(`[${TARGET}:${this.port}] ${line}`);
      }
    }
    if (pending) this.logs.push(pending);
  }

  private async spawn(): Promise<void> {
    const child = Bun.spawn({
      cmd: serverCommand(),
      cwd: REPO_ROOT,
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    this.process = child;
    void this.pump(child.stdout as ReadableStream<Uint8Array>);
    void this.pump(child.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`the ${TARGET} server exited with ${child.exitCode} while starting:\n${this.logs.join("\n")}`);
      }
      try {
        const response = await fetch(`${this.origin}/api/health`);
        await response.arrayBuffer();
        if (response.status === 200) return;
      } catch {
        // not listening yet
      }
      await sleep(50);
    }
    throw new Error(`the ${TARGET} server did not become healthy:\n${this.logs.join("\n")}`);
  }

  /** How many log lines so far contain `text`. */
  logCount(text: string): number {
    return this.logs.filter((line) => line.includes(text)).length;
  }

  /** Resolves once `count` log lines contain `text` (by default, once one more than now does). */
  async waitForLog(text: string, { count, timeoutMs = 30_000 }: { count?: number; timeoutMs?: number } = {}): Promise<void> {
    const target = count ?? Math.max(1, this.logCount(text));
    const deadline = Date.now() + timeoutMs;
    while (this.logCount(text) < target) {
      if (Date.now() > deadline) {
        throw new Error(`no log line containing "${text}" (wanted ${target}) within ${timeoutMs} ms:\n${this.logs.slice(-40).join("\n")}`);
      }
      if (this.process && this.process.exitCode !== null) {
        throw new Error(`the ${TARGET} server exited while waiting for "${text}":\n${this.logs.slice(-40).join("\n")}`);
      }
      await sleep(20);
    }
  }

  /** Polls `check` until it returns something truthy; throws after `timeoutMs`. */
  async waitFor<T>(check: () => Promise<T> | T, { timeoutMs = 15_000, what = "condition" } = {}): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  /** A client with no session. */
  anonymous(): ApiClient {
    return new ApiClient(this.origin, this.file, this.index);
  }

  /** A client signed in with a password; by default as the seeded `admin`. */
  async login(username = "admin", password = username === "demo" ? DEMO_PASSWORD : ADMIN_PASSWORD): Promise<ApiClient> {
    return this.anonymous().login(username, password);
  }

  /** The `user_id` of a user by name. */
  async userId(username: string): Promise<string> {
    const row = await this.db.one<{ user_id: string }>("SELECT user_id FROM users WHERE username = $1", [username]);
    if (!row) throw new Error(`no user named ${username}`);
    return row.user_id;
  }

  /**
   * Stops the server and starts it again on the same database and port, the
   * way a deploy does: in-memory state (rate limits, event buffers, caches) is
   * gone, stored state stays, and the boot-time scheduled sync runs again.
   */
  async restart(env: Record<string, string | undefined> = {}, { skipSyncWait = false } = {}): Promise<void> {
    await this.kill();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete this.env[key];
      else this.env[key] = value;
    }
    const syncs = this.logCount("Scheduled sync completed");
    await this.spawn();
    if (!skipSyncWait) await this.waitForLog("Scheduled sync completed", { count: syncs + 1 });
  }

  private async kill(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = null;
    child.kill("SIGTERM");
    const exited = await Promise.race([child.exited, sleep(5_000).then(() => "timeout" as const)]);
    if (exited === "timeout") {
      child.kill("SIGKILL");
      await child.exited;
    }
  }

  /** Copies the upstream calls made since the last call into the transcript. */
  private recordUpstream(): void {
    const { requests } = this.upstream.hub;
    for (const request of requests.slice(this.upstreamRecorded)) {
      const headers: Record<string, string> = {};
      for (const name of UPSTREAM_HEADERS) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
      record(this.file, {
        kind: "upstream",
        stack: this.index,
        host: request.host,
        method: request.method,
        path: request.path,
        search: request.search,
        body: { headers, body: request.json ?? request.body },
      });
    }
    this.upstreamRecorded = requests.length;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.kill();
    this.recordUpstream();
    flush(this.file);
    this.upstream.issuer.stop();
    await this.upstream.hub.stop();
    await this.db.drop();
  }
}

export const startStack = (options: StackOptions = {}): Promise<Stack> => Stack.start(options, callerTestFile());
