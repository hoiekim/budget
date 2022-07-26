import { Route, GetResponse, updateAccount } from "server";

const getResponse: GetResponse<{ account_id: string }> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  try {
    const response = await updateAccount(req.body);
    return { status: "success", data: { account_id: response._id } };
  } catch (error: any) {
    console.error(`Failed to update an account: ${req.body.account_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/account", getResponse);

export default route;
