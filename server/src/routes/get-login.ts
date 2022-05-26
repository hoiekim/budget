import { Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  const { user } = req.session;
  return {
    status: "success",
    data: user,
    info: user ? undefined : "Not logged in.",
  };
};

const route = new Route("GET", "/login", getResponse);

export default route;
