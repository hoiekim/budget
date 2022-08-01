import { Route, GetResponse, deleteBudget } from "server";

const getResponse: GetResponse = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const budget_id = req.query.id as string;

  await deleteBudget(user, budget_id);

  return { status: "success" };
};

const route = new Route("DELETE", "/budget", getResponse);

export default route;
