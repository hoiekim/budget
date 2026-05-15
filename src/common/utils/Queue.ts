/**
 * Rate-limited async work queue. Lets at most `capacity` tasks complete
 * inside any sliding `windowMs` window. Tasks are added via `queue.add(fn)`
 * and execute as soon as a slot is available; callers `await` the result.
 *
 * Used for paid / rate-limited external APIs (e.g. Polygon free-tier =
 * 5/min). Cache hits and other no-op work should NOT route through here —
 * only the operation that actually consumes a slot.
 *
 * `capacity` may be a static number or a getter; the getter is re-evaluated
 * on every `add()` so env-driven caps can change at runtime (tests do this).
 * `capacity <= 0` disables the gate.
 */
export interface QueueOptions {
  capacity: number | (() => number);
  windowMs?: number;
}

export class Queue {
  private readonly getCapacity: () => number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(options: QueueOptions) {
    const { capacity, windowMs = 60_000 } = options;
    this.getCapacity = typeof capacity === "function" ? capacity : () => capacity;
    this.windowMs = windowMs;
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    const cap = this.getCapacity();
    if (cap <= 0) return task();

    while (true) {
      const now = Date.now();
      const cutoff = now - this.windowMs;
      while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < cap) {
        this.timestamps.push(now);
        return task();
      }
      const oldest = this.timestamps[0]!;
      const sleepMs = Math.max(10, oldest + this.windowMs - now);
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  /** Test-only: drain the in-memory slot record. */
  reset(): void {
    this.timestamps.length = 0;
  }
}
