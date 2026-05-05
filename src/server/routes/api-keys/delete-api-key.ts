import { Route, revokeApiKey } from "server";
import { requireQueryString } from "server/lib/validation";

export interface ApiKeyDeleteResponse {
  revoked: boolean;
}

export const deleteApiKeyRoute = new Route<ApiKeyDeleteResponse>(
  "DELETE",
  "/api-keys",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const idResult = requireQueryString(req, "key_id");
    if (!idResult.success) {
      return { status: "failed", message: idResult.error };
    }

    const revoked = await revokeApiKey(idResult.data!, user.user_id);
    if (!revoked) {
      return { status: "failed", message: "Key not found or already revoked." };
    }
    return { status: "success", body: { revoked: true } };
  },
);
