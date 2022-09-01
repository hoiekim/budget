import bcrypt from "bcrypt";
import { Route, searchUser, MaskedUser, maskUser } from "server";

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
      const maskedUser = maskUser(user);
      req.session.user = maskedUser;
      return { status: "success", data: maskedUser };
    }

    return { status: "failed", info: "Wrong password." };
  }
);
