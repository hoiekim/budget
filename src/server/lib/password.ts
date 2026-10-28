/**
 * Password hashing seam, backed by Bun's native password hashing.
 *
 * Bun.password verifies the bcrypt hashes this repo has always stored
 * (cost 10, $2b$ format), so existing passwords keep working with no
 * migration — and new hashes use the same format and cost. The change
 * from the bcrypt package is purely a dependency removal, not a crypto
 * change.
 *
 * The indirection exists for the same reason as ./postgres/sql-driver:
 * bun's mock.module() cannot override the "bun" builtin, so tests that
 * need a fake hash/verify mock this module instead of Bun.password.
 */
export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  Bun.password.verify(password, hash);
