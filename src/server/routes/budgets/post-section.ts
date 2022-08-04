import { Route, GetResponse, updateSection } from "server";

const getResponse: GetResponse = async (req) => {
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

  try {
    await updateSection(user, req.body);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update(create) a section: ${req.body.section_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/section", getResponse);

export default route;
