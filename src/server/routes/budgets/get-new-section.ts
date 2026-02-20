import { Route, createSection, requireQueryString, validationError } from "server";

export type NewSectionGetResponse = { section_id: string };

export const getNewSectionRoute = new Route<NewSectionGetResponse>(
  "GET",
  "/new-section",
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

    const response = await createSection(user, { budget_id: parentResult.data! });

    if (!response) {
      return { status: "failed", message: "Failed to create section." };
    }
    return { status: "success", body: { section_id: response.section_id } };
  }
);
