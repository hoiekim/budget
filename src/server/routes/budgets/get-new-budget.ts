import { JSONBudget } from "common";
import { createBudget, makeGetNewEntityRoute } from "server";

export type NewBudgetGetResponse = { budget: JSONBudget };

export const getNewBudgetRoute = makeGetNewEntityRoute("/new-budget", createBudget, {
  bodyKey: "budget",
  failureMessage: "Failed to create budget.",
});
