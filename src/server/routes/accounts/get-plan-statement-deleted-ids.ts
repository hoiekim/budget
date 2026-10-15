import { Route, requireQueryString, validationError, getDeletedPlanStatementIds } from "server";

export interface PlanStatementDeletedIds {
  ids: string[];
}

/**
 * GET /plan-statement/deleted-ids?account_id=
 * The account's deleted plan-statement rows, which the import page plans around.
 */
export const getPlanStatementDeletedIdsRoute = new Route<PlanStatementDeletedIds>(
  "GET",
  "/plan-statement/deleted-ids",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };
    const accountId = requireQueryString(req, "account_id");
    if (!accountId.success) return validationError(accountId.error!);
    return { status: "success", body: { ids: await getDeletedPlanStatementIds(user, accountId.data!) } };
  },
);
