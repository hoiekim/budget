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

  // Use constant-time comparison even when user not found to prevent timing attacks.
  // The dummy hash is a valid bcrypt hash (bcrypt of "dummy" at cost 10) so the
  // comparison takes the same time as a real one, preventing timing-based enumeration.
  const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
  const pwMatches = user
    ? await bcrypt.compare(passwordResult.data!, user.password)
    : await bcrypt.compare(passwordResult.data!, DUMMY_HASH).then(() => false);

  if (pwMatches && user) {
    const maskedUser = maskUser(user);
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    req.session.user = maskedUser;
    return { status: "success", body: maskedUser };
  }

  // Return the same generic message regardless of whether the username exists
  // to prevent username enumeration attacks.
  return { status: "failed", message: "Invalid username or password." };
});
