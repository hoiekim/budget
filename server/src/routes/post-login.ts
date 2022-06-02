import bcrypt from "bcrypt";
import { Route, GetResponse, searchUser } from "lib";

const getResponse: GetResponse = async (req) => {
  const { username, password } = req.body;

  const user = await searchUser({ username });
  if (!user) return { status: "failed", info: "User is not found." };

  const pwMatches = await bcrypt.compare(password, user.password);

  if (pwMatches) {
    const safeUser = { ...user, password: undefined };
    req.session.user = safeUser;
    return { status: "success", data: safeUser };
  }

  return { status: "failed", info: "Wrong password." };
};

const route = new Route("POST", "/login", getResponse);

export default route;
