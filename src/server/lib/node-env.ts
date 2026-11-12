// Bracket access on purpose: Bun.build folds `process.env.NODE_ENV` into a literal at bundle time.
export const nodeEnv = (): string | undefined => process.env["NODE_ENV"];

export const isProduction = (): boolean => nodeEnv() === "production";
