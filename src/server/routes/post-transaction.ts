import { Route, GetResponse, updateTransaction } from "server";

const getResponse: GetResponse = async (req) => {
  try {
    await updateTransaction(req.body);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update a transaction: ${req.body.transaction_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/transaction", getResponse);

export default route;
