/**
 * Discord alarm module for server error notifications.
 *
 * Sends a POST to the DISCORD_ALARM_WEBHOOK URL when errors occur, under two
 * independent limits: a per-key cooldown so one chatty source cannot starve the
 * others, and a global per-window ceiling so a broad outage (every route 5xxing
 * into its own bucket) cannot burst past Discord's webhook rate limit.
 */

import { logger } from "server/lib/logger";

const COOLDOWN_MS = 60_000; // 1 minute

/**
 * Ceiling on webhook POSTs per COOLDOWN_MS across all keys. `Route.execute`
 * buckets per registered route path, so a total outage has as many eligible
 * keys as there are routes — Discord rate-limits well below that.
 */
const MAX_SENDS_PER_WINDOW = 10;

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
 * Send a Discord webhook alarm message.
 *
 * @param title Embed title (also the default cooldown key)
 * @param detail Embed description
 * @param key Cooldown bucket. Defaults to `title`. Pass an explicit value for
 *   sources whose title is fixed but whose volume is caller-driven, so their
 *   traffic is charged to one bucket instead of the reporting source's.
 */
export const sendAlarm = async (
  title: string,
  detail: string,
  key: string = title
): Promise<void> => {
  const webhookUrl = process.env.DISCORD_ALARM_WEBHOOK;
  if (!webhookUrl) return;

  const now = Date.now();
  pruneExpired(now);

  const last = lastAlarmAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;

  if (sendTimestamps.length >= MAX_SENDS_PER_WINDOW) {
    logger.warn("Discord alarm dropped — global rate ceiling reached", {
      key,
      title,
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

/** Reset cooldown state (for testing). */
export const resetAlarmState = (): void => {
  lastAlarmAt.clear();
  sendTimestamps.length = 0;
};

/** Live cooldown bucket count (for testing the prune keeps this O(active keys)). */
export const getCooldownKeyCount = (): number => lastAlarmAt.size;
