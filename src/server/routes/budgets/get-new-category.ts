import { Route, createCategory, requireQueryString, validationError } from "server";

export type NewCategoryGetResponse = { category_id: string };

export const getNewCategoryRoute = new Route<NewCategoryGetResponse>(
  "GET",
  "/new-category",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const parentResult = requireQueryString(req, "parent");
    if (!parentResult.success) return validationError(parentResult.error!);

    const response = await createCategory(user, { section_id: parentResult.data! });

    if (!response) {
      return { status: "failed", message: "Failed to create category." };
    }
    return { status: "success", body: { category_id: response.category_id } };
  }
);
