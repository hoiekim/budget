import { Route, updateAccounts, requireBodyObject, validationError } from "server";
import { logger } from "server/lib/logger";

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

  const body = bodyResult.data;

  try {
    const response = await updateAccounts(user, [body as any]);
    const result = response[0];
    if (!result || result.status >= 400) {
      throw new Error("Unknown error during account upsert");
    }
    const account_id = result.update._id;
    if (!account_id) throw new Error("Account ID is missing after upsert");
    return { status: "success", body: { account_id } };
  } catch (error: any) {
    logger.error("Failed to update account", { accountId: (body as any).account_id }, error);
    throw new Error(error);
  }
});
