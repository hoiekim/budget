import { Route, GetResponse, User } from "lib";

const getResponse: GetResponse<Omit<User, "password">> = async (req) => {
  const { user } = req.session;
  return {
    status: "success",
    data: user,
    info: user ? undefined : "Not logged in.",
  };
};

const route = new Route("GET", "/login", getResponse);

export default route;
