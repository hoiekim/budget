/**
 * The HTTP client tests drive a server with. It keeps cookies the way a
 * browser tab would, so a `login()` carries over to the requests after it,
 * and it never follows redirects, so a test sees the redirect itself.
 */
import { nextSeq, record, type HttpRecord } from "./transcript";

export interface RequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | Array<string | number>>;
  /** Sent as JSON, with a JSON content type, unless `rawBody` is given. */
  body?: unknown;
  /** Sent as is; set the content type through `headers`. */
  rawBody?: string | Uint8Array;
  /** Leave the stored cookies out of this request. */
  noCookies?: boolean;
  /** Keep this exchange out of the cross-server comparison (its answer is not deterministic). */
  noCompare?: boolean;
  signal?: AbortSignal;
}

export interface ApiResult<T = unknown> {
  status: number;
  headers: Headers;
  /** The response body parsed as JSON; `undefined` when it is not JSON. */
  json: { status?: string; body?: T; message?: string } & Record<string, unknown>;
  /** Shorthand for `json.body`. */
  body: T;
  text: string;
  /** The `Set-Cookie` headers of the response. */
  setCookies: string[];
}

const HEADERS_NOT_COMPARED = new Set(["date", "content-length", "transfer-encoding", "connection", "keep-alive", "server"]);

export class ApiClient {
  readonly cookies = new Map<string, string>();

  constructor(
    readonly origin: string,
    private readonly file: string,
    private readonly stackIndex: number,
  ) {}

  /** A client on the same server with no cookies: another browser. */
  fresh(): ApiClient {
    return new ApiClient(this.origin, this.file, this.stackIndex);
  }

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private storeCookies(setCookies: string[]): void {
    for (const cookie of setCookies) {
      const [pair, ...attributes] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const maxAge = attributes.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      if (value === "" || maxAge === "max-age=0") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  url(path: string, query?: RequestOptions["query"]): string {
    // `path` is under /api unless it starts with "//", which means "exactly this path".
    const full = path.startsWith("//") ? path.slice(1) : `/api${path}`;
    if (!query) return this.origin + full;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
      else params.append(key, String(value));
    }
    const search = params.toString();
    return this.origin + full + (search ? (full.includes("?") ? "&" : "?") + search : "");
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const seq = nextSeq(this.file);
    const headers: Record<string, string> = { ...options.headers };
    let body: string | Uint8Array | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
    const hasCookieHeader = Object.keys(headers).some((h) => h.toLowerCase() === "cookie");
    if (!options.noCookies && !hasCookieHeader && this.cookies.size > 0) headers.Cookie = this.cookieHeader();

    const response = await fetch(this.url(path, options.query), {
      method,
      headers,
      body,
      redirect: "manual",
      signal: options.signal,
    });
    const text = await response.text();
    let json: ApiResult<T>["json"];
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined as unknown as ApiResult<T>["json"];
    }
    const setCookies = response.headers.getSetCookie();
    if (!options.noCookies) this.storeCookies(setCookies);

    if (!options.noCompare) {
      const recorded: HttpRecord["headers"] = {};
      response.headers.forEach((value, key) => {
        if (!HEADERS_NOT_COMPARED.has(key) && key !== "set-cookie") recorded[key] = value;
      });
      if (setCookies.length > 0) recorded["set-cookie"] = setCookies;
      record(this.file, {
        kind: "http",
        seq,
        stack: this.stackIndex,
        method,
        path: this.url(path, options.query).slice(this.origin.length),
        requestBody: options.rawBody !== undefined ? String(options.rawBody).slice(0, 2000) : options.body,
        status: response.status,
        headers: recorded,
        body: json === undefined ? text.slice(0, 20000) : json,
      });
    }

    return {
      status: response.status,
      headers: response.headers,
      json,
      body: (json as { body?: T } | undefined)?.body as T,
      text,
      setCookies,
    };
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>("GET", path, options);
  }

  post<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return this.request<T>("POST", path, { ...options, body });
  }

  delete<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>("DELETE", path, options);
  }

  /** Signs in with a password and keeps the session cookie. Throws unless the server says success. */
  async login(username: string, password: string): Promise<this> {
    const result = await this.post("/login", { username, password });
    if (result.status !== 200 || result.json?.status !== "success") {
      throw new Error(`login as ${username} failed: ${result.status} ${result.text}`);
    }
    return this;
  }
}
