import { Route, GetResponse, MaskedUser } from "server";

const getResponse: GetResponse<MaskedUser> = async (req) => {
  const { user } = req.session;
  return {
    status: "success",
    data: user,
    info: user ? undefined : "Not logged in.",
  };
};

const route = new Route("GET", "/login", getResponse);

export default route;
