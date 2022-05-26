import { getAccounts, Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  if (req.session.user?.username !== "admin") {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const response = await getAccounts();
  if (!response) throw new Error("Server failed to get accounts.");

  return {
    status: "success",
    data: response,
  };
};

const route = new Route("GET", "/accounts", getResponse);

export default route;
