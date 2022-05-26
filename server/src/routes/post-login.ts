import { Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  const password = req.body.password;

  if (password === process.env.ADMIN_PASSWORD) {
    const user = { id: "admin", username: "admin" };
    req.session.user = user;
    return { status: "success", data: user };
  }

  return { status: "failed", info: "Wrong password." };
};

const route = new Route("POST", "/login", getResponse);

export default route;
