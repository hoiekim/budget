import { Route, updateSection } from "server";

export const postSectionRoute = new Route("POST", "/section", async (req) => {
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

  const { section_id, ...data } = req.body;
  if (!section_id) {
    return {
      status: "failed",
      message: "section_id is required but not provided.",
    };
  }

  try {
    await updateSection(user, section_id, data);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update a section: ${section_id}`);
    throw new Error(error);
  }
});
