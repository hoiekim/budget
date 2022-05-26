import { Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  req.session.user = undefined;
  return { status: "success" };
};

const route = new Route("DELETE", "/login", getResponse);

export default route;
