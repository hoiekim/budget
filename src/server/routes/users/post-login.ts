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

  // Use constant-time comparison even when user not found to prevent timing attacks
  const dummyHash = "$2b$10$invalidhashfortimingattackprevention000000000000000000000";
  const pwMatches = user
    ? await bcrypt.compare(passwordResult.data!, user.password)
    : await bcrypt.compare(passwordResult.data!, dummyHash).then(() => false);

  if (pwMatches && user) {
    const maskedUser = maskUser(user);
    req.session.user = maskedUser;
    return { status: "success", body: maskedUser };
  }

  // Return the same generic message regardless of whether the username exists
  // to prevent username enumeration attacks.
  return { status: "failed", message: "Invalid username or password." };
});
