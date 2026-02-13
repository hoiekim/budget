import dotenv from "dotenv";

export const importConfig = () => {
  const { NODE_ENV } = process.env;
  const extraEnv = NODE_ENV ? ".env." + NODE_ENV : "";
  [".env", ".env.local", extraEnv].forEach((path) => dotenv.config({ path }));
};

export const setModulePaths = () => {
  // With Bun, module paths are resolved at build time via tsconfig paths
  // This function is kept for backward compatibility but is a no-op in Bun
  if (typeof Bun === "undefined") {
    // Node.js fallback (if needed)
    const paths = ["src", "build/server"];
    const isWindows = process.platform === "win32";
    process.env.NODE_PATH = paths.join(isWindows ? ";" : ":");
    require("module").Module._initPaths();
  }
};

export const overrideConsoleLog = () => {
  process.env.TZ = "America/Los_Angeles";
  const { log, info, error } = console;
  console.log = (...args: unknown[]) => {
    const now = new Date();
    const timestamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
    log(timestamp, ...args);
  };
  console.info = (...args: unknown[]) => {
    const now = new Date();
    const timestamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
    info(timestamp, ...args);
  };
  console.error = (...args: unknown[]) => {
    const now = new Date();
    const timestamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
    error(timestamp, ...args);
  };
};
