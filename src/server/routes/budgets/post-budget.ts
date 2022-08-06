import { Route, GetResponse, updateBudget } from "server";

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

  if (!req.body.budget_id) {
    return {
      status: "failed",
      info: "budget_id is required but not provided.",
    };
  }

  try {
    await updateBudget(user, req.body);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update a budget: ${req.body.budget_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/budget", getResponse);

export default route;
