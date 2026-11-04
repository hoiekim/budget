import { deleteBudget, makeDeleteEntityRoute } from "server";

export const deleteBudgetRoute = makeDeleteEntityRoute("/budget", deleteBudget);
