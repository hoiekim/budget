import { Route, GetResponse, NewBudgetResponse, createBudget } from "server";

const getResponse: GetResponse<NewBudgetResponse> = async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const response = await createBudget(user);
  return { status: "success", data: { budget_id: response._id } };
};

const route = new Route("GET", "/new-budget", getResponse);

export default route;
