import { exchangePublicToken, Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  if (req.session.user?.username !== "admin") {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const token = req.body.token;
  const response = await exchangePublicToken(token);
  if (!response) throw new Error("Server failed to exchange token.");

  return { status: "success" };
};

const route = new Route("POST", "/public-token", getResponse);

export default route;
