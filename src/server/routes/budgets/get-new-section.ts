import { Route, GetResponse, NewSectionResponse, createSection } from "server";

const getResponse: GetResponse<NewSectionResponse> = async (req, res) => {
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
};

const route = new Route("GET", "/new-section", getResponse);

export default route;
