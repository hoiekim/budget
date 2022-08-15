import { Route, deleteCategory } from "server";

export const deleteCategoryRoute = new Route("DELETE", "/category", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const category_id = req.query.id as string;

  if (!category_id) {
    return {
      status: "failed",
      info: "id is required but not provided.",
    };
  }

  await deleteCategory(user, category_id);

  return { status: "success" };
});
