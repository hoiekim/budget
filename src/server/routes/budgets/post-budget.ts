import { Route, GetResponse, createBudget, updateBudget } from "server";

const getResponse: GetResponse<{ budget_id: string }> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  try {
    let response:
      | Awaited<ReturnType<typeof updateBudget>>
      | Awaited<ReturnType<typeof createBudget>>;
    if (req.body) response = await updateBudget(req.body);
    else response = await createBudget(user);
    return { status: "success", data: { budget_id: response._id } };
  } catch (error: any) {
    console.error(`Failed to update(create) a budget: ${req.body.budget_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/budget", getResponse);

export default route;
