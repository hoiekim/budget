import { Route, GetResponse, NewSectionResponse, createSection } from "server";

const getResponse: GetResponse<NewSectionResponse> = async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const response = await createSection(user);
  return { status: "success", data: { section_id: response._id } };
};

const route = new Route("GET", "/new-section", getResponse);

export default route;
