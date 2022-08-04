import { searchBudgets, Route, GetResponse, BudgetsResponse } from "server";

const getResponse: GetResponse<BudgetsResponse> = async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const data = await searchBudgets(user);

  return { status: "success", data };
};

const route = new Route("GET", "/budgets", getResponse);

export default route;
