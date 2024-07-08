import { importConfig, setModulePaths, overrideConsoleLog } from "./config";
importConfig();
setModulePaths();
overrideConsoleLog();

import path from "path";
import express, { Router } from "express";
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

const router = Router();

router.use((req, _res, next) => {
  console.info(`<${req.method}> /api${req.url}`);
  next();
});

Object.values(routes).forEach(({ path, handler }) => router.use(path, handler));

app.use("/api", router);

const clientPath = path.resolve(__dirname, "..", "client");

app.use(express.static(clientPath));

app.get("*", (_req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.listen(process.env.PORT || 3005, async () => {
  await initializeIndex();
  console.info("Budget app server is up.");
});
