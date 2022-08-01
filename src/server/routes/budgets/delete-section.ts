import { Route, GetResponse, deleteSection } from "server";

const getResponse: GetResponse = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const section_id = req.query.id as string;

  await deleteSection(user, section_id);

  return { status: "success" };
};

const route = new Route("DELETE", "/section", getResponse);

export default route;
