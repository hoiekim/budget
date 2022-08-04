import { Route, GetResponse, NewCategoryResponse, createCategory } from "server";

const getResponse: GetResponse<NewCategoryResponse> = async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const response = await createCategory(user);
  return { status: "success", data: { category_id: response._id } };
};

const route = new Route("GET", "/new-category", getResponse);

export default route;
