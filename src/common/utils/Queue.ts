/**
 * Async work queue with two independent gates. Tasks are added via
 * `queue.add(fn)` and execute as soon as both gates allow it; callers
 * `await` the result.
 *
 * Gates:
 * - `capacity` (per `windowMs`) — sliding-window rate limit. Up to
 *   `capacity` tasks may START inside any `windowMs` window. Built for
 *   paid / rate-limited external APIs (e.g. Polygon free-tier = 5/min).
 *   Cache hits and other no-op work should NOT route through here — only
 *   the operation that actually consumes a slot. `capacity <= 0` disables
 *   the rate gate.
 * - `maxInflight` — concurrency cap. At most `maxInflight` tasks run
 *   simultaneously. Built for browser fetch storms where queueing hundreds
 *   of `fetch`/`cache.add` calls at once triggers
 *   `ERR_INSUFFICIENT_RESOURCES` and silently aborts cache writes.
 *   `maxInflight <= 0` (or unset) disables the concurrency gate.
 *
 * `capacity` and `maxInflight` may each be a static number or a getter;
 * getters are re-evaluated on every `add()` so env-driven caps can change
 * at runtime (tests do this).
 *
 * `maxWaitMs` bounds how long a task may sit waiting for a rate slot before
 * `add()` rejects with `QueueWaitTimeoutError`. It bounds the rate gate only
 * — a task already past that gate is never timed out, and the concurrency
 * gate stays unbounded. Set it per queue, or per call via
 * `add(task, { maxWaitMs })`; `<= 0` (or unset) waits indefinitely.
 */
export interface QueueOptions {
  capacity?: number | (() => number);
  windowMs?: number;
  maxInflight?: number | (() => number);
  maxWaitMs?: number;
}

export interface QueueAddOptions {
  maxWaitMs?: number;
}

/**
 * Thrown by `add()` when the rate gate could not produce a slot within
 * `maxWaitMs`. Callers that shed rather than queue — a request someone is
 * waiting on — should catch this and surface a retryable failure, leaving
 * the slot to whoever can still use it.
 */
export class QueueWaitTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`No rate slot available within ${waitedMs}ms`);
    this.name = "QueueWaitTimeoutError";
  }
}

export class Queue {
  private readonly getCapacity: () => number;
  private readonly windowMs: number;
  private readonly getMaxInflight: () => number;
  private readonly defaultMaxWaitMs: number;
  private readonly timestamps: number[] = [];
  private inflight = 0;
  private readonly inflightWaiters: Array<() => void> = [];

  constructor(options: QueueOptions) {
    const { capacity = 0, windowMs = 60_000, maxInflight = 0, maxWaitMs = 0 } = options;
    this.getCapacity = typeof capacity === "function" ? capacity : () => capacity;
    this.windowMs = windowMs;
    this.getMaxInflight = typeof maxInflight === "function" ? maxInflight : () => maxInflight;
    this.defaultMaxWaitMs = maxWaitMs;
  }

  async add<T>(task: () => Promise<T>, options: QueueAddOptions = {}): Promise<T> {
    await this.waitForRateSlot(options.maxWaitMs ?? this.defaultMaxWaitMs);
    await this.acquireInflight();
    try {
      return await task();
    } finally {
      this.releaseInflight();
    }
  }

  private async waitForRateSlot(maxWaitMs: number): Promise<void> {
    const cap = this.getCapacity();
    if (cap <= 0) return;
    const deadline = maxWaitMs > 0 ? Date.now() + maxWaitMs : Infinity;
    while (true) {
      const now = Date.now();
      const cutoff = now - this.windowMs;
      while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < cap) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0]!;
      const freesAt = oldest + this.windowMs;
      if (freesAt > deadline) throw new QueueWaitTimeoutError(maxWaitMs);
      const sleepMs = Math.max(10, freesAt - now);
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  private async acquireInflight(): Promise<void> {
    const max = this.getMaxInflight();
    if (max <= 0) return;
    while (this.inflight >= max) {
      await new Promise<void>((resolve) => this.inflightWaiters.push(resolve));
    }
    this.inflight++;
  }

  private releaseInflight(): void {
    const max = this.getMaxInflight();
    if (max <= 0) return;
    this.inflight--;
    const next = this.inflightWaiters.shift();
    if (next) next();
  }

  /** Test-only: drain the in-memory slot record. */
  reset(): void {
    this.timestamps.length = 0;
    this.inflight = 0;
    this.inflightWaiters.length = 0;
  }
}
