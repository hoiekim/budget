import { JSONCategory } from "common";
import { Route, createCategory, requireQueryString, validateFields, validationError } from "server";

export type NewCategoryGetResponse = { category: JSONCategory };

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
    const parentShape = validateFields({ parent: parentResult.data }, [{ path: "parent", type: "uuid" }]);
    if (!parentShape.success) return validationError(parentShape.error!);

    const response = await createCategory(user, { section_id: parentResult.data! });

    if (!response) {
      return { status: "failed", message: "Failed to create category." };
    }
    return { status: "success", body: { category: response } };
  }
);
