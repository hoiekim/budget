import {
  Route,
  updateAccounts,
  requireBodyObject,
  requireStringField,
  validationError,
  getHoldingsByAccount,
} from "server";
import type { PartialAccount } from "server";
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

  // Block direct edits to `balances.current` when the account already has
  // holdings — total should be derived from the holdings table (including a
  // cash-type holding for uninvested cash). Per Hoie 2026-05-13: "when
  // there are holdings, don't allow direct updates to the account total.
  // Instead allow them to update the cash amount in the holdings summary."
  const balancesIn = body.balances as Record<string, unknown> | undefined;
  if (balancesIn && "current" in balancesIn) {
    const holdings = await getHoldingsByAccount(user, idResult.data!);
    if (holdings.length > 0) {
      return validationError(
        "Account total cannot be edited directly when holdings exist. Update the cash row in Holdings Composition instead.",
      );
    }
  }

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
    logger.error("Failed to update account", { accountId: idResult.data }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
