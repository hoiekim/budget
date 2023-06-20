import { Route, createCategory } from "server";

export type NewCategoryGetResponse = { category_id: string };

export const getNewCategoryRoute = new Route<NewCategoryGetResponse>(
  "GET",
  "/new-category",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const section_id = req.query.parent as string;
    if (!section_id) throw new Error("Parent id is required but not provided.");
    const response = await createCategory(user, section_id);

    return { status: "success", body: { category_id: response._id } };
  }
);
