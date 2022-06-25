import { Route, GetResponse, updateAccount } from "server";

const getResponse: GetResponse = async (req) => {
  try {
    await updateAccount(req.body);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update an account: ${req.body.account_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/account", getResponse);

export default route;
