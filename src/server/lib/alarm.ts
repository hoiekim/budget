/**
 * Discord alarm module for server error notifications.
 *
 * Sends a POST to the DISCORD_ALARM_WEBHOOK URL when errors occur.
 * A 1-minute cooldown per alarm key prevents noise bursts without letting one
 * chatty source (e.g. the unauthenticated /api/client-error beacon) starve
 * other sources.
 */

import { logger } from "server/lib/logger";

const COOLDOWN_MS = 60_000; // 1 minute

const lastAlarmAt = new Map<string, number>();

/**
 * Send a Discord webhook alarm message. Respects a per-key cooldown so traffic
 * on one key cannot suppress alarms from other sources.
 *
 * @param title Embed title (also the default cooldown key)
 * @param detail Embed description
 * @param key Cooldown bucket. Defaults to `title`. Pass an explicit value for
 *   sources that may fire frequently — notably `/api/client-error`, which is
 *   unauthenticated, so with a single shared bucket one request per minute was
 *   enough to silently suppress every server-side alarm (route 5xx,
 *   uncaughtException, unhandledRejection, scheduled-sync and Plaid failures).
 */
export const sendAlarm = async (
  title: string,
  detail: string,
  key: string = title
): Promise<void> => {
  const webhookUrl = process.env.DISCORD_ALARM_WEBHOOK;
  if (!webhookUrl) return;

  const now = Date.now();
  const last = lastAlarmAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;
  lastAlarmAt.set(key, now);

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
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    // Don't throw — alarm failure should never crash the server
    logger.error("Failed to send Discord alarm", {}, err);
  }
};

/** Reset cooldown state (for testing). */
export const resetAlarmState = (): void => {
  lastAlarmAt.clear();
};
