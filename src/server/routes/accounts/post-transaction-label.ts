import { Route, GetResponse, updateTransactionLabel } from "server";

const getResponse: GetResponse<{ transaction_id: string }> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const { transaction_id, label } = req.body;

  try {
    const response = await updateTransactionLabel(user, { transaction_id }, label);
    return { status: "success", data: { transaction_id: response._id } };
  } catch (error: any) {
    console.error(`Failed to update a transaction: ${transaction_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/transaction-label", getResponse);

export default route;
