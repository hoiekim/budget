import bcrypt from "bcrypt";
import { Route, searchUser, MaskedUser } from "server";

export type LoginPostResponse = MaskedUser;

export const postLoginRoute = new Route<LoginPostResponse>(
  "POST",
  "/login",
  async (req) => {
    const { username, password } = req.body;

    const user = await searchUser({ username });
    if (!user) return { status: "failed", info: "User is not found." };

    const pwMatches = await bcrypt.compare(password, user.password);

    if (pwMatches) {
      const { user_id, username, items } = user;
      const safeUser: MaskedUser = { user_id, username, items };
      req.session.user = safeUser;
      return { status: "success", data: safeUser };
    }

    return { status: "failed", info: "Wrong password." };
  }
);
