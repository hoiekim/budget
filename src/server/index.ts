import { config } from "dotenv";

const { NODE_ENV } = process.env;
const extraEnv = NODE_ENV ? ".env." + NODE_ENV : "";
[".env", ".env.local", extraEnv].forEach((path) => config({ path }));

const paths = ["src", "build"];
const isWindows = process.platform === "win32";
if (isWindows) process.env.NODE_PATH = paths.join(";");
else process.env.NODE_PATH = paths.join(":");
require("module").Module._initPaths();

export * from "./lib";

import express from "express";
import session from "express-session";
import path from "path";
import { initializeIndex, User } from "server";
import * as routes from "server/routes";

declare module "express-session" {
  export interface SessionData {
    user: Omit<User, "password">;
  }
}

const app = express();

app.use(express.json({ limit: "50mb" }));

app.use(
  session({
    secret: process.env.SECRET || "secret",
    resave: true,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

const router = express.Router();

router.use((req, res, next) => {
  console.info(`<${req.method}> /api${req.url}`);
  console.group();
  const date = new Date();
  const offset = date.getTimezoneOffset() / -60;
  const offsetString = (offset > 0 ? "+" : "") + offset + "H";
  console.info(`at: ${date.toLocaleString()}, ${offsetString}`);
  console.info(`from: ${req.ip}`);
  console.groupEnd();
  next();
});

Object.values(routes).forEach((route) => {
  const { path, handler } = route;
  router.use(path, handler);
});

app.use("/api", router);

const clientPath = path.resolve(__dirname, "../client");
app.use(express.static(clientPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.listen(process.env.PORT || 3005, async () => {
  await initializeIndex();
  console.info("Budget app server is up.");
});
