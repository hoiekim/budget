import { Route, createApiKey, logger } from "server";
import { isString, isStringArray } from "common";

export interface ApiKeyPostResponse {
  key_id: string;
  prefix: string;
  /** Full plaintext key — shown ONCE to the issuing user, never persisted server-side. */
  plaintext: string;
}

const ALLOWED_SCOPES = new Set<string>(["transactions:suggest"]);

export const postApiKeysRoute = new Route<ApiKeyPostResponse>(
  "POST",
  "/api-keys",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const body = req.body as { name?: unknown; scopes?: unknown; expires_at?: unknown } | null;
    if (!body) return { status: "failed", message: "Body must be JSON." };
    if (!isString(body.name) || body.name.trim() === "") {
      return { status: "failed", message: "name is required and must be a non-empty string." };
    }
    if (body.name.length > 255) {
      return { status: "failed", message: "name must be 255 characters or fewer." };
    }
    if (!isStringArray(body.scopes) || body.scopes.length === 0) {
      return { status: "failed", message: "scopes must be a non-empty string array." };
    }
    for (const scope of body.scopes) {
      if (!ALLOWED_SCOPES.has(scope)) {
        return { status: "failed", message: `Unknown scope: ${scope}` };
      }
    }
    let expires_at: string | null | undefined = undefined;
    if (body.expires_at !== undefined && body.expires_at !== null) {
      if (!isString(body.expires_at)) {
        return { status: "failed", message: "expires_at must be an ISO timestamp string." };
      }
      const ts = Date.parse(body.expires_at);
      if (Number.isNaN(ts)) {
        return { status: "failed", message: "expires_at is not a valid ISO timestamp." };
      }
      if (ts <= Date.now()) {
        return { status: "failed", message: "expires_at must be in the future." };
      }
      expires_at = new Date(ts).toISOString();
    }

    try {
      const created = await createApiKey({
        user_id: user.user_id,
        name: body.name.trim(),
        scopes: body.scopes,
        expires_at,
      });
      return {
        status: "success",
        body: { key_id: created.key_id, prefix: created.prefix, plaintext: created.plaintext },
      };
    } catch (error) {
      logger.error("Failed to create API key", { userId: user.user_id }, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);
