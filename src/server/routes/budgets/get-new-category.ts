import { Route, createCategory } from "server";

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

    const section_id = req.query.parent as string;
    if (!section_id) throw new Error("Parent id is required but not provided.");
    const response = await createCategory(user, { section_id });

    if (!response) {
      return { status: "failed", message: "Failed to create category." };
    }
    return { status: "success", body: { category_id: response.category_id } };
  }
);
