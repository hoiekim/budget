import { getTransactions, Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  if (req.session.user?.username !== "admin") {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const response = await getTransactions();
  if (!response) throw new Error("Server failed to get transactions.");

  return {
    status: "success",
    data: response,
  };
};

const route = new Route("GET", "/transactions", getResponse);

export default route;
