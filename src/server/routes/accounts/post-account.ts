import { ItemProvider } from "common";
import {
  Route,
  createAccount,
  getAccount,
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

  const existing = await getAccount(user, idResult.data!);

  if (!existing) {
    const itemIdResult = requireStringField(body, "item_id");
    if (!itemIdResult.success) return validationError(itemIdResult.error!);

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
    const result: UpsertResult | undefined = existing
      ? (await updateAccounts(user, [body as PartialAccount]))[0]
      : await createAccount(user, body as CreatableAccount);

    // 200 is the only status that means a row was written. 304 (no row matched)
    // and 404 (zero row count) both mean the write silently did nothing.
    if (!result || result.status !== 200) {
      throw new Error(`Account write did not persist, status ${result?.status ?? "missing"}`);
    }
    const account_id = result.update._id;
    if (!account_id) throw new Error("Account ID is missing after upsert");
    return { status: "success", body: { account_id } };
  } catch (error: unknown) {
    logger.error("Failed to write account", { accountId: idResult.data }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
