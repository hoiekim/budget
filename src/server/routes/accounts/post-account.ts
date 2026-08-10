import {
  Route,
  updateAccounts,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec, PartialAccount } from "server";
import { logger } from "server/lib/logger";

export interface AccountPostResponse {
  account_id: string;
}

/**
 * Every typed field `AccountModel.fromJSON` copies into a row, mirroring the
 * column types in `models/account.ts`. All of them are nullable there, so an
 * explicit null clears the column rather than failing. `account_id` is checked
 * separately (`requireStringField`) because it is the only required one.
 */
const ACCOUNT_BODY_SPEC: FieldSpec[] = [
  { path: "name", type: "string", nullable: true },
  { path: "type", type: "string", nullable: true },
  { path: "subtype", type: "string", nullable: true },
  { path: "custom_name", type: "string", nullable: true },
  { path: "hide", type: "boolean", nullable: true },
  { path: "archived", type: "boolean", nullable: true },
  { path: "label.budget_id", type: "uuid", nullable: true },
  { path: "balances.available", type: "number", nullable: true },
  { path: "balances.current", type: "number", nullable: true },
  { path: "balances.limit", type: "number", nullable: true },
  { path: "balances.iso_currency_code", type: "string", nullable: true },
  { path: "graphOptions.useSnapshots", type: "boolean", nullable: true },
  { path: "graphOptions.useHoldingSnapshots", type: "boolean", nullable: true },
  { path: "graphOptions.useTransactions", type: "boolean", nullable: true },
];

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

  const fieldsResult = validateFields(body, ACCOUNT_BODY_SPEC);
  if (!fieldsResult.success) return validationError(fieldsResult.error!);

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
