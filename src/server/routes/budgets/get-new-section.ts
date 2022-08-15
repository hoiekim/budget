import { Route, createSection } from "server";

export type NewSectionGetResponse = { section_id: string };

export const getNewSectionRoute = new Route<NewSectionGetResponse>(
  "GET",
  "/new-section",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    const budget_id = req.query.parent as string;
    if (!budget_id) throw new Error("Parent id is required but not provided.");
    const response = await createSection(user, budget_id);

    return { status: "success", data: { section_id: response._id } };
  }
);
