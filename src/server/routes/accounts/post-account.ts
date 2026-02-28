import { Route, updateAccounts, requireBodyObject, requireStringField, validationError } from "server";
import type { PartialAccount } from "server";

export interface AccountPostResponse {
  account_id: string;
}

export const postAccountRoute = new Route<AccountPostResponse>("POST", "/account", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);

  const body = bodyResult.data as Record<string, unknown>;

  const idResult = requireStringField(body, "account_id");
  if (!idResult.success) return validationError(idResult.error!);

  try {
    const response = await updateAccounts(user, [body as PartialAccount]);
    const result = response[0];
    if (!result || result.status >= 400) {
      throw new Error("Unknown error during account upsert");
    }
    const account_id = result.update._id;
    if (!account_id) throw new Error("Account ID is missing after upsert");
    return { status: "success", body: { account_id } };
  } catch (error: unknown) {
    console.error(`Failed to update an account: ${idResult.data}`);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
