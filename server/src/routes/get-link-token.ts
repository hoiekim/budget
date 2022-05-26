import { getLinkToken, Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  if (req.session.user?.username !== "admin") {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const response = await getLinkToken();
  if (!response) throw new Error("Server failed to get link token.");

  return {
    status: "success",
    data: response.link_token,
  };
};

const route = new Route("GET", "/link-token", getResponse);

export default route;
