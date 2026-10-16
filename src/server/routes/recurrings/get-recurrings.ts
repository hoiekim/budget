import { Route, getRecurrings, Recurring, optionalQueryString, validationError } from "server";

export type RecurringsGetResponse = Recurring[];

export const getRecurringsRoute = new Route<RecurringsGetResponse>("GET", "/recurrings", async (req) => {
  const { user } = req.session;
  if (!user) {
    return { status: "failed", message: "Request user is not authenticated." };
  }

  // Same opt-in eviction-signal contract as /transfers: `useSync` opts in
  // on a warm sync and after a failed purge, not on a healthy cold load.
  const includeDeletedResult = optionalQueryString(req, "include-deleted");
  if (!includeDeletedResult.success) return validationError(includeDeletedResult.error!);

  const startResult = optionalQueryString(req, "start-date");
  if (!startResult.success) return validationError(startResult.error!);

  const recurrings = await getRecurrings(user, {
    includeDeleted: includeDeletedResult.data === "true",
    startDate: startResult.data,
  });
  return { status: "success", body: recurrings };
});
