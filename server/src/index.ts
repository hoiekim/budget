const { NODE_PATH, NODE_ENV } = process.env;

let envPath = ".env";
if (NODE_ENV) envPath += "." + NODE_ENV;
require("dotenv").config({ path: envPath });

if (!NODE_PATH) {
  const paths = ["server/build", "server/src"];
  const isWindows = process.platform === "win32";
  if (isWindows) process.env.NODE_PATH = paths.join(";");
  else process.env.NODE_PATH = paths.join(":");
}
require("module").Module._initPaths();

import express from "express";
import session from "express-session";
import path from "path";
import * as routes from "routes";
import { initializeIndex, User } from "lib";

// initializeIndex();

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
  try {
    next();
  } catch (error) {
    console.error(error);
  }
});

Object.values(routes).forEach((route) => {
  const { path, handler } = route;
  router.use(path, handler);
});

app.use("/api", router);

const clientPath = path.resolve(__dirname, "../../build");
app.use(express.static(clientPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.listen(process.env.PORT || 3005, () => {
  console.info("Budget app server is up.");
});
