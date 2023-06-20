import { Route, deleteSection } from "server";

export const deleteSectionRoute = new Route("DELETE", "/section", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const section_id = req.query.id as string;

  if (!section_id) {
    return {
      status: "failed",
      message: "id is required but not provided.",
    };
  }

  await deleteSection(user, section_id);

  return { status: "success" };
});
