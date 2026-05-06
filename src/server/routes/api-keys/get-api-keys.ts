import { Route, listApiKeys, ApiKeyJSON } from "server";

export interface ApiKeysGetResponse {
  api_keys: Omit<ApiKeyJSON, "key_hash" | "revoked_at">[];
}

export const getApiKeysRoute = new Route<ApiKeysGetResponse>(
  "GET",
  "/api-keys",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };
    const keys = await listApiKeys(user.user_id);
    return { status: "success", body: { api_keys: keys } };
  },
);
