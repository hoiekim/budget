import { Route, updateCategory } from "server";

export const postCategoryRoute = new Route("POST", "/category", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  if (!req.body || !Object.keys(req.body).length) {
    return {
      status: "failed",
      message: "Request body is required but not provided.",
    };
  }

  if (!req.body.category_id) {
    return {
      status: "failed",
      message: "category_id is required but not provided.",
    };
  }

  try {
    await updateCategory(user, req.body);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update a category: ${req.body.category_id}`);
    throw new Error(error);
  }
});
