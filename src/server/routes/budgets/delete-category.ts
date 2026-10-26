import { Route, deleteCategory, requireQueryString, validateFields, validationError } from "server";

export const deleteCategoryRoute = new Route("DELETE", "/category", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);
  // `id` becomes a UUID-column predicate below: reject a malformed
  // value here (400-style failed answer, no alarm) instead of
  // letting Postgres raise 22P02 inside Route.execute.
  const idCheck = validateFields(req.query, [{ path: "id", type: "uuid", required: true }]);
  if (!idCheck.success) return validationError(idCheck.error!);

  await deleteCategory(user, idResult.data!);

  return { status: "success" };
});
