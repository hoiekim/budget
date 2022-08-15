import { Route, updateSection } from "server";

export const postSectionRoute = new Route("POST", "/section", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  if (!req.body || !Object.keys(req.body).length) {
    return {
      status: "failed",
      info: "Request body is required but not provided.",
    };
  }

  if (!req.body.section_id) {
    return {
      status: "failed",
      info: "section_id is required but not provided.",
    };
  }

  try {
    await updateSection(user, req.body);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update a section: ${req.body.section_id}`);
    throw new Error(error);
  }
});
