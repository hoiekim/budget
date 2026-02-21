import { Route, deleteCategory, requireQueryString, validationError } from "server";

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

  await deleteCategory(user, idResult.data!);

  return { status: "success" };
});
