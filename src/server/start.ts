import { importConfig, setModulePaths, overrideConsoleLog } from "./config";
importConfig();
setModulePaths();
overrideConsoleLog();

import path from "path";
import express, { Router } from "express";
import session from "express-session";
import { initializePostgres, PostgresSessionStore, scheduledSync } from "server";
import * as routes from "server/routes";

const app = express();

app.use(express.json({ limit: "50mb" }));

if (!process.env.SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ FATAL: SECRET env var must be set in production!");
    process.exit(1);
  }
  console.warn("⚠️  WARNING: SECRET env var not set. Using insecure default.");
}
const sessionSecret = process.env.SECRET || "secret";

app.use(
  session({
    secret: sessionSecret,
    resave: true,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: false,
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
    store: new PostgresSessionStore(),
  }),
);

const router = Router();

router.use((req, _res, next) => {
  console.info(`<${req.method}> /api${req.url}`);
  next();
});

Object.values(routes).forEach(({ path, handler }) => router.use(path, handler));

app.use("/api", router);

const clientPath = path.resolve(import.meta.dir, "..", "client");

app.use(express.static(clientPath));

app.get("*", (_req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.listen(process.env.PORT || 3005, async () => {
  await initializePostgres();
  console.info("Budget app server is up.");
  scheduledSync();
});
