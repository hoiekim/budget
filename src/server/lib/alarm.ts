/**
 * Discord alarm module for server error notifications.
 *
 * Sends a POST to the DISCORD_ALARM_WEBHOOK URL when errors occur, under two
 * independent limits: a per-key cooldown so one chatty source cannot starve the
 * others, and a global per-window ceiling so a broad outage (every route 5xxing
 * into its own bucket) cannot burst past Discord's webhook rate limit.
 *
 * The ceiling is split into two lanes. Recurring sources stop short of the top
 * so that single-shot sources — the crash handlers, which fire once and are
 * never retried — always have somewhere to go during the outage that produced
 * them.
 */

import { logger } from "server/lib/logger";

const COOLDOWN_MS = 60_000; // 1 minute

/**
 * Ceiling on webhook POSTs per COOLDOWN_MS across all keys. `Route.execute`
 * buckets per registered route path, so a total outage has as many eligible
 * keys as there are routes — Discord rate-limits well below that.
 */
export const MAX_SENDS_PER_WINDOW = 10;

/**
 * Slots at the top of the ceiling that only single-shot sources may take.
 *
 * The ceiling is otherwise arrival-ordered, which is the wrong priority for
 * the sources that matter most. `Route.execute` fires per failing request and
 * re-competes as the window slides, so a broad outage can hold every slot.
 * `unhandledRejection` / `uncaughtException` fire once, are not retried, and
 * carry the crash itself — a refusal drops them permanently, precisely when
 * the process is least able to tell anyone what happened.
 *
 * Sized to the number of distinct single-shot cooldown keys — one per crash
 * handler. Each key can land at most once per window because the cooldown
 * equals the ceiling window, so a reserve of that size makes every single-shot
 * source deliverable. A new single-shot caller with a new key must raise it.
 */
export const SINGLE_SHOT_RESERVE = 2;

/** Lane a caller competes in for the per-window ceiling. */
type AlarmLane = "recurring" | "single-shot";

const ceilingFor = (lane: AlarmLane): number =>
  lane === "single-shot"
    ? MAX_SENDS_PER_WINDOW
    : MAX_SENDS_PER_WINDOW - SINGLE_SHOT_RESERVE;

const lastAlarmAt = new Map<string, number>();
const sendTimestamps: number[] = [];

/** Drop cooldown entries and send timestamps that can no longer suppress anything. */
const pruneExpired = (now: number): void => {
  const cutoff = now - COOLDOWN_MS;
  for (const [key, at] of lastAlarmAt) {
    if (at <= cutoff) lastAlarmAt.delete(key);
  }
  while (sendTimestamps.length && sendTimestamps[0]! <= cutoff) sendTimestamps.shift();
};

/**
 * Send a Discord webhook alarm message. Never rejects — a delivery failure is
 * logged, so no caller has to guard against one.
 *
 * @param title Embed title (also the default cooldown key)
 * @param detail Embed description
 * @param key Cooldown bucket. Defaults to `title`. Pass an explicit value for
 *   sources whose title is fixed but whose volume is caller-driven, so their
 *   traffic is charged to one bucket instead of the reporting source's.
 * @param lane Which slice of the per-window ceiling to compete for. Only
 *   sources that fire once and are never retried may pass `"single-shot"`.
 */
export const sendAlarm = async (
  title: string,
  detail: string,
  key: string = title,
  lane: AlarmLane = "recurring"
): Promise<void> => {
  const webhookUrl = process.env.DISCORD_ALARM_WEBHOOK;
  if (!webhookUrl) return;

  const now = Date.now();
  pruneExpired(now);

  const last = lastAlarmAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;

  const ceiling = ceilingFor(lane);
  if (sendTimestamps.length >= ceiling) {
    logger.warn("Discord alarm dropped — global rate ceiling reached", {
      key,
      title,
      lane,
      ceiling,
      windowSends: sendTimestamps.length,
    });
    return;
  }

  lastAlarmAt.set(key, now);
  sendTimestamps.push(now);

  const body = JSON.stringify({
    embeds: [
      {
        title: `🚨 Budget Server Error: ${title}`,
        description: detail.slice(0, 4000),
        color: 0xff0000,
        timestamp: new Date().toISOString(),
      },
    ],
  });

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // A non-2xx means this alarm was never delivered. The cooldown stays
    // committed (retrying into a rate limit makes it worse), so without this
    // branch the drop is silent.
    if (!response.ok) {
      logger.error("Discord alarm rejected by webhook", {
        key,
        title,
        status: response.status,
      });
    }
  } catch (err) {
    // Don't throw — alarm failure should never crash the server
    logger.error("Failed to send Discord alarm", { key, title }, err);
  }
};

/**
 * Max time a crash handler waits for its alarm to reach Discord before the
 * process exits anyway. Bounded so a slow or unreachable webhook cannot turn
 * a crash into a hang.
 */
export const CRASH_ALARM_TIMEOUT_MS = 5_000;

/** Render a thrown value as the alarm body: message plus a bounded stack. */
export const formatCrashDetail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``;
};

/**
 * Send a crash alarm in the single-shot lane without waiting for it.
 *
 * For crash paths the process outlives, where the POST flushes on its own.
 *
 * @example
 * process.on("unhandledRejection", (reason) => {
 *   void reportCrashAlarm("Unhandled Promise Rejection", reason);
 * });
 */
export const reportCrashAlarm = (title: string, error: unknown): Promise<void> =>
  sendAlarm(title, formatCrashDetail(error), title, "single-shot");

/**
 * Send a crash alarm in the single-shot lane and wait for it, bounded by
 * `timeoutMs`.
 *
 * Load-bearing on any path that exits: `sendAlarm` POSTs to a webhook, and a
 * fire-and-forget call followed by `process.exit` kills the process before the
 * request flushes, so the crash pages nobody.
 *
 * @param timeoutMs Bound on the wait. Defaults to `CRASH_ALARM_TIMEOUT_MS`.
 */
export const deliverCrashAlarm = async (
  title: string,
  error: unknown,
  timeoutMs: number = CRASH_ALARM_TIMEOUT_MS
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    reportCrashAlarm(title, error),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
};

/** Reset cooldown state (for testing). */
export const resetAlarmState = (): void => {
  lastAlarmAt.clear();
  sendTimestamps.length = 0;
};

/** Live cooldown bucket count (for testing the prune keeps this O(active keys)). */
export const getCooldownKeyCount = (): number => lastAlarmAt.size;
