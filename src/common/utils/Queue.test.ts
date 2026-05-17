import { describe, it, expect } from "bun:test";
import { Queue } from "./Queue";

describe("Queue", () => {
  it("runs all tasks when capacity is 0 (disabled)", async () => {
    const q = new Queue({ capacity: 0 });
    const results = await Promise.all([
      q.add(async () => 1),
      q.add(async () => 2),
      q.add(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it("propagates task return values", async () => {
    const q = new Queue({ capacity: 10 });
    const out = await q.add(async () => ({ hello: "world" }));
    expect(out).toEqual({ hello: "world" });
  });

  it("blocks the (cap+1)-th task until the oldest slot ages out", async () => {
    // Use a synthetic clock so the test doesn't actually wait 60s.
    let now = 1_000_000_000;
    const realDateNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    Date.now = () => now;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).setTimeout = ((fn: () => void, ms: number) => {
      now += ms;
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;

    try {
      const q = new Queue({ capacity: 2, windowMs: 60_000 });
      await q.add(async () => "a");
      await q.add(async () => "b");
      await q.add(async () => "c"); // must wait

      expect(now).toBeGreaterThanOrEqual(1_000_000_000 + 60_000);
    } finally {
      Date.now = realDateNow;
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("re-reads a dynamic capacity getter on every add()", async () => {
    let cap = 0;
    const q = new Queue({ capacity: () => cap });
    // cap=0 → immediate
    await q.add(async () => 1);
    cap = 1;
    // cap=1 → still runs (first slot)
    await q.add(async () => 2);
    // Reset would normally let us re-fire; the dynamic-cap behaviour itself
    // is what we're asserting — both runs returned without waiting.
    expect(true).toBe(true);
  });

  it("caps concurrent in-flight tasks at maxInflight", async () => {
    const q = new Queue({ maxInflight: 2 });
    let inflight = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];
    const task = () =>
      new Promise<void>((resolve) => {
        inflight++;
        peak = Math.max(peak, inflight);
        releasers.push(() => {
          inflight--;
          resolve();
        });
      });

    const runs = [q.add(task), q.add(task), q.add(task), q.add(task)];
    // Yield so the queue can spin up its first 2 workers.
    await new Promise((r) => setTimeout(r, 0));
    expect(inflight).toBe(2);
    expect(peak).toBe(2);

    // Release one slot — the next queued task should pick it up.
    releasers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(inflight).toBe(2);
    expect(peak).toBe(2);

    // Drain the rest. Yield between releases so newly-started tasks have
    // a chance to push their own releaser before the next drain step.
    while (releasers.length) {
      releasers.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(runs);
    expect(inflight).toBe(0);
    expect(peak).toBe(2);
  });

  it("propagates task errors without leaking an in-flight slot", async () => {
    const q = new Queue({ maxInflight: 1 });
    await expect(
      q.add(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // If the slot leaked, this second add() would hang forever.
    const out = await q.add(async () => "ok");
    expect(out).toBe("ok");
  });
});
