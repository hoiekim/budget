/**
 * Discord alarm module for server error notifications.
 *
 * Sends a POST to the DISCORD_ALARM_WEBHOOK URL when errors occur.
 * A 1-minute cooldown prevents noise bursts.
 * ERROR_THRESHOLD env var (default: 1) sets how many errors trigger an alarm.
 */

import { logger } from "server/lib/logger";

const COOLDOWN_MS = 60_000; // 1 minute
const ERROR_THRESHOLD = parseInt(process.env.ERROR_THRESHOLD || "1", 10);

let lastAlarmAt = 0;
let errorCount = 0;

/** Send a Discord webhook alarm message. Respects cooldown. */
export const sendAlarm = async (title: string, detail: string): Promise<void> => {
  const webhookUrl = process.env.DISCORD_ALARM_WEBHOOK;
  if (!webhookUrl) return;

  errorCount++;
  if (errorCount < ERROR_THRESHOLD) return;

  const now = Date.now();
  if (now - lastAlarmAt < COOLDOWN_MS) return;
  lastAlarmAt = now;
  errorCount = 0;

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
  lastAlarmAt = 0;
  errorCount = 0;
};
