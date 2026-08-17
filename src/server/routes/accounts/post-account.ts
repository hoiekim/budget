import {
  Route,
  updateAccounts,
  requireBodyObject,
  requireStringField,
  validationError,
} from "server";
import type { PartialAccount } from "server";
import { logger } from "server/lib/logger";

export interface AccountPostResponse {
  account_id: string;
}

/**
 * Edit an existing account. Purely UPDATE — create lives on the sibling
 * `GET /new-account` mint route, so a body naming an `account_id` that
 * does not exist yet answers `Account not found.` instead of an
 * ambiguous 304-that-looks-like-success (#668). `item_id` and
 * `institution_id` are create-only and stripped in `updateAccounts`.
 */
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
    const updated = (await updateAccounts(user, [body as PartialAccount]))[0];
    if (updated?.status === 200) {
      const account_id = updated.update._id;
      if (!account_id) throw new Error("Account ID is missing after write");
      return { status: "success", body: { account_id } };
    }
    if (updated?.status === 304) {
      return { status: "failed", message: "Account not found." };
    }
    throw new Error(`Account update did not persist, status ${updated?.status ?? "missing"}`);
  } catch (error: unknown) {
    logger.error("Failed to update account", { accountId: idResult.data }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
