import { Route, GetResponse, deleteCategory } from "server";

const getResponse: GetResponse = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const category_id = req.query.id as string;

  await deleteCategory(user, category_id);

  return { status: "success" };
};

const route = new Route("DELETE", "/category", getResponse);

export default route;