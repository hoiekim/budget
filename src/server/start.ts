import { importConfig, setModulePaths } from "./config";
importConfig();
setModulePaths();

import path from "path";
import express from "express";
import session from "express-session";
import { initializeIndex, ElasticsearchSessionStore } from "server";
import * as routes from "server/routes";

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
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
    store: new ElasticsearchSessionStore(),
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

Object.values(routes).forEach(({ path, handler }) => router.use(path, handler));

app.use("/api", router);

const clientPath = path.resolve(__dirname, "..", "client");

app.use(express.static(clientPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.listen(process.env.PORT || 3005, async () => {
  await initializeIndex();
  console.info("Budget app server is up.");
});
