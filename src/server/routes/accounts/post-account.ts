import { ItemProvider, isUndefined } from "common";
import {
  Route,
  createAccount,
  getItem,
  updateAccounts,
  requireBodyObject,
  requireStringField,
  validationError,
} from "server";
import type { CreatableAccount, PartialAccount, UpsertResult } from "server";
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

  const body = bodyResult.data as Record<string, unknown>;

  const idResult = requireStringField(body, "account_id");
  if (!idResult.success) return validationError(idResult.error!);

  // A create posts a whole Account, `item_id` included; an edit posts only the
  // fields it changes and never carries one. Reading the row back to classify
  // the request instead would put an extra statement on every edit.
  const isCreate = !isUndefined(body.item_id);

  if (isCreate) {
    const itemIdResult = requireStringField(body, "item_id");
    if (!itemIdResult.success) return validationError(itemIdResult.error!);

    // institution_id is NOT NULL, so an INSERT needs it up front.
    const institutionIdResult = requireStringField(body, "institution_id");
    if (!institutionIdResult.success) return validationError(institutionIdResult.error!);

    const item = await getItem(user, itemIdResult.data!);
    if (!item) {
      return {
        status: "failed",
        message: "Item not found.",
      };
    }

    if (item.provider !== ItemProvider.MANUAL) {
      return {
        status: "failed",
        message: "Account is not a manual account.",
      };
    }
  }

  try {
    const result: UpsertResult | undefined = isCreate
      ? await createAccount(user, body as CreatableAccount)
      : (await updateAccounts(user, [body as PartialAccount]))[0];

    switch (result?.status) {
      case 200: {
        const account_id = result.update._id;
        if (!account_id) throw new Error("Account ID is missing after write");
        return { status: "success", body: { account_id } };
      }
      case 304:
        // The UPDATE matched no row: the account is gone, or was never the
        // requesting user's.
        return { status: "failed", message: "Account not found." };
      case 409:
        return { status: "failed", message: "Account already exists." };
      default:
        throw new Error(`Account write did not persist, status ${result?.status ?? "missing"}`);
    }
  } catch (error: unknown) {
    logger.error("Failed to write account", { accountId: idResult.data }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
