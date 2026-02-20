import { Route, deleteSection, requireQueryString, validationError } from "server";

export const deleteSectionRoute = new Route("DELETE", "/section", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  await deleteSection(user, idResult.data!);

  return { status: "success" };
});
