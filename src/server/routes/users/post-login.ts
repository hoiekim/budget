import bcrypt from "bcrypt";
import { Route, searchUser, MaskedUser, maskUser, requireBodyObject, requireStringField, validationError } from "server";

export type LoginPostResponse = MaskedUser;

export const postLoginRoute = new Route<LoginPostResponse>("POST", "/login", async (req) => {
  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);

  const body = bodyResult.data as Record<string, unknown>;
  const usernameResult = requireStringField(body, "username");
  if (!usernameResult.success) return validationError(usernameResult.error!);

  const passwordResult = requireStringField(body, "password");
  if (!passwordResult.success) return validationError(passwordResult.error!);

  const user = await searchUser({ username: usernameResult.data! });
  if (!user) return { status: "failed", message: "User is not found." };

  const pwMatches = await bcrypt.compare(passwordResult.data!, user.password);

  if (pwMatches) {
    const maskedUser = maskUser(user);
    req.session.user = maskedUser;
    return { status: "success", body: maskedUser };
  }

  return { status: "failed", message: "Wrong password." };
});
