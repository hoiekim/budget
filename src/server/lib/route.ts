import { logger } from "server/lib/logger";
import { sendAlarm } from "server/lib/alarm";
import type { MaskedUser } from "./postgres/models/user";

export type Method = "GET" | "POST" | "DELETE";

export interface ApiResponse<T = undefined> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}

export type Stream<T = undefined> = (response: ApiResponse<T>) => void;

/** `T` with any array inside it allowed to arrive as an async iterable of batches. */
export type Batched<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (infer U)[] ? T[K] | AsyncIterable<U[]> : Batched<T[K]>;
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown[]> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

async function* serializeJson(value: unknown): AsyncGenerator<string> {
  if (isAsyncIterable(value)) {
    yield "[";
    let first = true;
    for await (const batch of value) {
      if (batch.length === 0) continue;
      const items = batch.map((item) => JSON.stringify(item) ?? "null").join(",");
      yield first ? items : "," + items;
      first = false;
    }
    yield "]";
  } else if (isPlainObject(value)) {
    yield "{";
    let first = true;
    for (const [key, property] of Object.entries(value)) {
      if (property === undefined) continue;
      yield `${first ? "" : ","}${JSON.stringify(key)}:`;
      first = false;
      yield* serializeJson(property);
    }
    yield "}";
  } else {
    yield JSON.stringify(value) ?? "null";
  }
}

/**
 * A JSON response serialized while it is sent. Each async iterable inside the
 * value is written as a JSON array one batch at a time, so a large result is
 * never held whole, neither as rows nor as one string.
 *
 * @example
 * return new JsonStream<TransactionsGetResponse>({
 *   status: "success",
 *   body: { transactions: searchTransactions(user).transactions, investmentTransactions: [] },
 * });
 */
export class JsonStream<T = unknown> {
  constructor(readonly value: Batched<ApiResponse<T>>) {}

  /** `onError` fires if producing a batch throws after the response has started. */
  toReadableStream(onError: (error: unknown) => void): ReadableStream<Uint8Array> {
    const chunks = serializeJson(this.value);
    const encoder = new TextEncoder();
    // A client that disconnects cancels the stream while a batch may still be
    // loading; whatever that batch then does is no longer an error to report.
    let cancelled = false;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await chunks.next();
          if (cancelled) return;
          if (done) controller.close();
          else controller.enqueue(encoder.encode(value));
        } catch (error) {
          if (cancelled) return;
          onError(error);
          controller.error(error);
        }
      },
      async cancel() {
        cancelled = true;
        await chunks.return(undefined);
      },
    });
  }
}

export interface ServerSession {
  user?: MaskedUser;
  id: string;
  regenerate(callback: (err?: Error) => void): void;
  destroy(callback?: (err?: Error) => void): void;
}

export interface ServerRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  rawBody?: string;
  session: ServerSession;
  ip: string;
  /**
   * Abort signal from the underlying HTTP request. Fires when the client
   * disconnects. Routes that hold long-lived responses open (e.g. SSE)
   * subscribe to it to release resources on tab close.
   */
  signal?: AbortSignal;
  /**
   * Widens this one request's idle deadline, in seconds (255 max — Bun's
   * ceiling). Bun reaps any request that goes `idleTimeout` seconds without
   * traffic, default 10; a route that holds a response open with long
   * silences between writes (SSE) must raise its own deadline rather than
   * the server relaxing it for every request.
   *
   * Required, not optional: with no implementation the stream dies at ~12s
   * with no error anywhere, so a caller that builds a `ServerRequest` has to
   * say what it does about it.
   */
  setIdleTimeout: (seconds: number) => void;
}

export interface ServerResponse {
  statusCode: number;
  headersSent: boolean;
  status(code: number): ServerResponse;
  write(data: string): boolean;
  end(): void;
}

export type GetResponse<T = undefined> = (
  req: ServerRequest,
  res: ServerResponse,
  stream: Stream<T>,
) => Promise<ApiResponse<T> | Response | JsonStream<T> | void>;

export class Route<T> {
  path: string;
  method: Method;
  callback: GetResponse<T>;
  /**
   * If set, this route accepts API-key bearer auth for clients holding a key
   * whose `scopes` array contains this string. Cookie-session auth is also
   * accepted (as a more privileged credential). Routes with no `requiredScope`
   * are cookie-only.
   */
  requiredScope?: string;

  constructor(
    method: Method,
    path: string,
    callback: GetResponse<T>,
    options: { requiredScope?: string } = {},
  ) {
    this.path = path;
    this.method = method;
    this.callback = callback;
    this.requiredScope = options.requiredScope;
  }

  async execute(
    req: ServerRequest,
    res: ServerResponse,
  ): Promise<ApiResponse<T> | Response | JsonStream<T> | null> {
    try {
      const stream: Stream<T> = (response) => {
        res.write(JSON.stringify(response) + "\n");
      };
      const result = await this.callback(req, res, stream);
      return result ?? null;
    } catch (error: unknown) {
      logger.error("Route handler error", { method: this.method, path: this.path }, error);
      sendAlarm(
        `Route Error: ${this.method} ${this.path}`,
        `**Error:** ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => undefined);
      res.status(500);
      return { status: "error", message: "Internal server error" };
    }
  }
}
