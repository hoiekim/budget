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

  const succeed = (result: UpsertResult) => {
    const account_id = result.update._id;
    if (!account_id) throw new Error("Account ID is missing after write");
    return { status: "success" as const, body: { account_id } };
  };

  // `item_id` decides which item an account hangs off, and the column carries
  // no foreign key — so it is validated wherever it appears, not only on the
  // create path. Writing it unchecked would let a request move an owned
  // account onto someone else's item, or onto a Plaid item that the
  // manual-only guard below exists to keep it off.
  if (!isUndefined(body.item_id)) {
    const itemIdResult = requireStringField(body, "item_id");
    if (!itemIdResult.success) return validationError(itemIdResult.error!);

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
    // UPDATE first, so the database decides whether this is an edit or a
    // create. Classifying by body shape instead — treating a request as a
    // create because it carries `item_id` — makes a server decision out of a
    // client convention: an edit that happens to send `item_id` would skip the
    // UPDATE, hit the primary key on INSERT, and report "already exists" for a
    // rename that should have succeeded. The hot edit path still costs the one
    // statement it always did.
    const updated = (await updateAccounts(user, [body as PartialAccount]))[0];
    if (updated?.status === 200) return succeed(updated);
    if (updated?.status !== 304) {
      throw new Error(`Account update did not persist, status ${updated?.status ?? "missing"}`);
    }

    // Either no live row of the user's carries this id, or the body held
    // nothing `buildUpdate` could set. A create needs the columns an edit never
    // has to supply, so a body without `item_id` can only be the former.
    if (isUndefined(body.item_id)) {
      return { status: "failed", message: "Account not found." };
    }

    // institution_id is NOT NULL, so an INSERT needs it up front.
    const institutionIdResult = requireStringField(body, "institution_id");
    if (!institutionIdResult.success) return validationError(institutionIdResult.error!);

    const created = await createAccount(user, body as CreatableAccount);

    switch (created?.status) {
      case 200:
        return succeed(created);
      case 409:
        // A soft-deleted row keeps its primary key, and the UPDATE above
        // deliberately does not match one, so the id is taken but unusable.
        return { status: "failed", message: "Account already exists." };
      default:
        throw new Error(`Account insert did not persist, status ${created?.status ?? "missing"}`);
    }
  } catch (error: unknown) {
    logger.error("Failed to write account", { accountId: idResult.data }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
