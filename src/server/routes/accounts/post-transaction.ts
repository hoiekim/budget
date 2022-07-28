import { Route, GetResponse, updateTransaction } from "server";

const getResponse: GetResponse<{ transaction_id: string }> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  try {
    const response = await updateTransaction(user, req.body);
    return { status: "success", data: { transaction_id: response._id } };
  } catch (error: any) {
    console.error(`Failed to update a transaction: ${req.body.transaction_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/transaction", getResponse);

export default route;
