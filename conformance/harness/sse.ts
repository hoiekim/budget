/**
 * A reader for the server-sent event stream, `GET /events`. It holds the
 * response open the way a browser tab's `EventSource` does, hands the test
 * each block as it arrives, and records the whole exchange in the transcript
 * once the stream is closed, so the two servers' streams are compared like
 * any other answer.
 *
 *   const stream = await openEventStream(client);
 *   const connected = await stream.next((block) => block.event === "connected");
 *   …
 *   await stream.close();
 */
import type { ApiClient } from "./client";
import { nextSeq, record, type HttpRecord } from "./transcript";

/** One block of the stream: a comment, or an event with its fields. */
export interface SseBlock {
  /** The text of a comment line (`: connected`), without the colon. */
  comment?: string;
  id?: string;
  event?: string;
  /** The `data:` field, parsed as JSON when it is JSON. */
  data?: unknown;
  /** The block as it was sent, without the blank line that ends it. */
  raw: string;
}

export interface EventStreamOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | Array<string | number>>;
  /** Keep this stream out of the cross-server comparison (what it carries is not deterministic). */
  noCompare?: boolean;
  path?: string;
}

const HEADERS_NOT_COMPARED = new Set(["date", "content-length", "transfer-encoding", "connection", "keep-alive", "server"]);

const parseBlock = (raw: string): SseBlock => {
  const block: SseBlock = { raw };
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) block.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) block.id = line.slice(4);
    else if (line.startsWith("event: ")) block.event = line.slice(7);
    else if (line.startsWith("data: ")) {
      const text = line.slice(6);
      try {
        block.data = JSON.parse(text);
      } catch {
        block.data = text;
      }
    }
  }
  return block;
};

export class EventStream {
  /** Every block received so far, oldest first. */
  readonly blocks: SseBlock[] = [];
  /** The response body as text, so far. */
  text = "";
  /** True once the response has ended, whoever ended it. */
  ended = false;
  /** True when the server ended the response; false while it is open or after this side closed it. */
  endedByServer = false;
  private cursor = 0;
  private pending = "";
  private closing = false;
  private recorded = false;
  private readonly waiters = new Set<() => void>();
  private reading: Promise<void> = Promise.resolve();

  private constructor(
    readonly status: number,
    readonly headers: Headers,
    private readonly controller: AbortController,
    private readonly entry: Omit<HttpRecord, "body"> | null,
    private readonly file: string,
  ) {}

  /** Opens the stream as `client` and returns once the response headers are in. */
  static async open(client: ApiClient, options: EventStreamOptions = {}): Promise<EventStream> {
    // The client keeps which test file and which server it belongs to to itself.
    const { file, stackIndex } = client as unknown as { file: string; stackIndex: number };
    const seq = nextSeq(file);
    const url = client.url(options.path ?? "/events", options.query);
    const headers: Record<string, string> = { ...options.headers };
    const hasCookieHeader = Object.keys(headers).some((name) => name.toLowerCase() === "cookie");
    if (!hasCookieHeader && client.cookies.size > 0) headers.Cookie = client.cookieHeader();
    const controller = new AbortController();
    const response = await fetch(url, { headers, redirect: "manual", signal: controller.signal });

    const recordedHeaders: HttpRecord["headers"] = {};
    response.headers.forEach((value, key) => {
      if (!HEADERS_NOT_COMPARED.has(key) && key !== "set-cookie") recordedHeaders[key] = value;
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) recordedHeaders["set-cookie"] = setCookies;
    const entry: Omit<HttpRecord, "body"> | null = options.noCompare
      ? null
      : {
          kind: "http",
          seq,
          stack: stackIndex,
          method: "GET",
          path: url.slice(client.origin.length),
          status: response.status,
          headers: recordedHeaders,
        };
    const stream = new EventStream(response.status, response.headers, controller, entry, file);
    stream.reading = stream.read(response);
    return stream;
  }

  private async read(response: Response): Promise<void> {
    const decoder = new TextDecoder();
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          const text = decoder.decode(chunk, { stream: true });
          this.text += text;
          this.pending += text;
          const parts = this.pending.split("\n\n");
          this.pending = parts.pop() ?? "";
          for (const raw of parts) this.blocks.push(parseBlock(raw));
          this.notify();
        }
      }
      this.endedByServer = !this.closing;
    } catch {
      // Aborted by `close`, or the server went away mid-stream.
      this.endedByServer = !this.closing;
    } finally {
      this.ended = true;
      this.notify();
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private async until<T>(check: () => T | undefined | false | null, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${what}; the stream so far (ended: ${this.ended}):\n${this.text}`);
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.waiters.add(wake);
      });
    }
  }

  /**
   * The next block not yet handed out that `matches`, waiting for it to
   * arrive. Blocks before it are skipped for good, so a test reads the
   * stream in order.
   */
  async next(matches: (block: SseBlock) => boolean = () => true, { timeoutMs = 10_000, what = "an event" } = {}): Promise<SseBlock> {
    return this.until(
      () => {
        while (this.cursor < this.blocks.length) {
          const block = this.blocks[this.cursor++];
          if (matches(block)) return block;
        }
        if (this.ended) throw new Error(`the stream ended before ${what} arrived:\n${this.text}`);
        return undefined;
      },
      what,
      timeoutMs,
    );
  }

  /** The next event block (comments skipped), as `{ id, event, data }`. */
  async nextEvent(options?: { timeoutMs?: number; what?: string }): Promise<{ id?: string; event: string; data: unknown }> {
    const block = await this.next((candidate) => candidate.event !== undefined, options);
    return block.id === undefined
      ? { event: block.event as string, data: block.data }
      : { id: block.id, event: block.event as string, data: block.data };
  }

  /** Resolves once the server has ended the response; throws if it stays open. */
  async waitForEnd({ timeoutMs = 10_000 } = {}): Promise<void> {
    await this.until(() => this.ended, "the stream to end", timeoutMs);
    this.finish();
  }

  /** Disconnects, the way closing the tab does, and files the exchange in the transcript. */
  async close(): Promise<void> {
    if (!this.ended) {
      this.closing = true;
      this.controller.abort();
    }
    await this.reading;
    this.finish();
  }

  private finish(): void {
    if (this.recorded || !this.entry) return;
    this.recorded = true;
    let body: unknown = this.text.slice(0, 20000);
    if (this.status !== 200) {
      try {
        body = JSON.parse(this.text);
      } catch {
        // not JSON: keep the text
      }
    }
    record(this.file, { ...this.entry, body });
  }

  /** The response body as JSON, for an answer that is not a stream (401, 429). Ends the exchange. */
  async json(): Promise<Record<string, unknown>> {
    await this.until(() => this.ended, "the response body", 10_000);
    this.finish();
    return JSON.parse(this.text);
  }
}

export const openEventStream = (client: ApiClient, options?: EventStreamOptions): Promise<EventStream> =>
  EventStream.open(client, options);
