import { getLinkToken, Route, GetResponse } from "server";

const getResponse: GetResponse<string> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const response = await getLinkToken(user);
  if (!response) throw new Error("Server failed to get link token.");

  return {
    status: "success",
    data: response.link_token,
  };
};

const route = new Route("GET", "/link-token", getResponse);

export default route;
