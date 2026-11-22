/**
 * The servers' view of the internet during a conformance run.
 *
 * Both servers reach their upstreams (Plaid, Polygon, Yahoo, BLS, Discord, a
 * SimpleFin bridge) over HTTPS at fixed host names. Rather than teach either
 * server a test-only base URL, each is started with `HTTPS_PROXY` pointing at
 * the proxy below and with the test certificate authority trusted. The proxy
 * accepts `CONNECT host:443` for any host and hands the connection to one
 * local TLS server, which answers from the handlers registered per host.
 *
 * A host nobody registered answers 502 and is listed in `unhandled`, so a
 * server that calls something unexpected fails loudly instead of reaching the
 * real service.
 */
import net from "node:net";
import { ensureCerts } from "../certs";

export interface UpstreamRequest {
  host: string;
  method: string;
  path: string;
  /** The raw query string, without the leading `?`. */
  search: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  /** The body parsed as JSON, when it is JSON. */
  json: unknown;
  form: URLSearchParams;
  /** Milliseconds since the epoch when it arrived. */
  at: number;
}

export type UpstreamHandler = (
  request: UpstreamRequest,
) => Response | undefined | void | Promise<Response | undefined | void>;

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export class UpstreamHub {
  /** Every request any upstream host received, oldest first. */
  readonly requests: UpstreamRequest[] = [];
  /** Requests to hosts or paths no handler answered. */
  readonly unhandled: UpstreamRequest[] = [];
  private readonly handlers = new Map<string, UpstreamHandler[]>();
  private readonly down = new Set<string>();
  private readonly sockets = new Set<net.Socket>();
  private readonly tls: ReturnType<typeof Bun.serve>;
  private readonly proxy: net.Server;
  private proxyPort = 0;
  readonly caPath: string;

  private constructor() {
    const certs = ensureCerts();
    this.caPath = certs.caPath;
    this.tls = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: Bun.file(certs.certPath), key: Bun.file(certs.keyPath) },
      fetch: (request) => this.answer(request, (request.headers.get("host") ?? "").replace(/:\d+$/, "")),
    });
    this.proxy = net.createServer((client) => this.tunnel(client));
  }

  static async start(): Promise<UpstreamHub> {
    const hub = new UpstreamHub();
    await new Promise<void>((resolve) => hub.proxy.listen(0, "127.0.0.1", resolve));
    hub.proxyPort = (hub.proxy.address() as net.AddressInfo).port;
    return hub;
  }

  /** The value for the servers' `HTTPS_PROXY`. */
  get proxyUrl(): string {
    return `http://127.0.0.1:${this.proxyPort}`;
  }

  private tunnel(client: net.Socket): void {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    client.once("data", (chunk: Buffer) => {
      const head = chunk.toString("latin1");
      const match = /^CONNECT ([^ :]+):(\d+) HTTP\/1\.[01]\r\n/.exec(head);
      if (!match) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (this.down.has(match[1])) {
        client.destroy();
        return;
      }
      const upstream = net.connect(this.tls.port!, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = chunk.subarray(head.indexOf("\r\n\r\n") + 4);
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      this.sockets.add(upstream);
      upstream.on("close", () => {
        this.sockets.delete(upstream);
        client.destroy();
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
  }

  /** Answers one request for `host`; also how a plain-HTTP fake (the identity provider) shares the log. */
  async answer(request: Request, host: string): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const seen: UpstreamRequest = {
      host,
      method: request.method,
      path: url.pathname,
      search: url.search.replace(/^\?/, ""),
      query: Object.fromEntries(url.searchParams),
      headers,
      body,
      json: parseJson(body),
      form: new URLSearchParams(body),
      at: Date.now(),
    };
    this.requests.push(seen);
    if (this.down.has(host)) return new Response(null, { status: 503 });
    for (const handler of this.handlers.get(host) ?? []) {
      const response = await handler(seen);
      if (response) return response;
    }
    this.unhandled.push(seen);
    return jsonResponse(502, { error: `conformance harness: nothing answers ${seen.method} ${host}${seen.path}` });
  }

  /**
   * Registers a handler for `host`. The newest handler is asked first; one
   * that returns nothing passes the request on to the handlers before it, so
   * a test overrides one path and leaves the rest of a fake standing.
   * Returns the function that removes it.
   */
  on(host: string, handler: UpstreamHandler): () => void {
    const list = this.handlers.get(host) ?? [];
    list.unshift(handler);
    this.handlers.set(host, list);
    return () => {
      const at = list.indexOf(handler);
      if (at !== -1) list.splice(at, 1);
    };
  }

  /** Makes `host` unreachable (connections are dropped) until set back. */
  setDown(host: string, isDown: boolean): void {
    if (isDown) this.down.add(host);
    else this.down.delete(host);
  }

  /** The requests `host` received, optionally only those whose path starts with `pathPrefix`. */
  seen(host: string, pathPrefix = ""): UpstreamRequest[] {
    return this.requests.filter((r) => r.host === host && r.path.startsWith(pathPrefix));
  }

  /** Forgets the request log; handlers stay. */
  clearSeen(): void {
    this.requests.length = 0;
    this.unhandled.length = 0;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.proxy.close(() => resolve()));
    await this.tls.stop(true);
  }
}
