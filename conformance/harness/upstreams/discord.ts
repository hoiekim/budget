/** The Discord webhook the servers send alarms to. */
import type { UpstreamHub, UpstreamRequest } from "./hub";

export const DISCORD_HOST = "discord.com";
export const DISCORD_WEBHOOK_PATH = "/api/webhooks/conformance/token";
export const DISCORD_WEBHOOK_URL = `https://${DISCORD_HOST}${DISCORD_WEBHOOK_PATH}`;

export interface AlarmEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
}

export class FakeDiscord {
  /** The status the webhook answers with; Discord answers 204. */
  status = 204;

  constructor(private readonly hub: UpstreamHub) {
    hub.on(DISCORD_HOST, (request) => {
      if (request.method === "POST" && request.path === DISCORD_WEBHOOK_PATH) {
        return new Response(null, { status: this.status });
      }
      return undefined;
    });
  }

  posts(): UpstreamRequest[] {
    return this.hub.seen(DISCORD_HOST, DISCORD_WEBHOOK_PATH);
  }

  /** Every alarm delivered so far, oldest first. */
  alarms(): AlarmEmbed[] {
    return this.posts().flatMap((post) => (post.json as { embeds?: AlarmEmbed[] })?.embeds ?? []);
  }
}
