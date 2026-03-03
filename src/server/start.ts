import { importConfig, setModulePaths, overrideConsoleLog } from "./config";
importConfig();
setModulePaths();
overrideConsoleLog();

import path from "path";
import express, { Router } from "express";
import session from "express-session";
import { initializePostgres, PostgresSessionStore, scheduledSync } from "server";
import { loginLimiter } from "server/lib/rate-limit";
import * as routes from "server/routes";

const app = express();

// Trust first proxy for secure cookie detection behind reverse proxy
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Parse JSON and store raw body for webhook verification
app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      // Store raw body for Plaid webhook verification
      if (req.url === "/plaid-hook") {
        (req as any).rawBody = buf.toString();
      }
    },
  })
);

app.use(
  session({
    secret: process.env.SECRET || "secret",
    resave: true,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: process.env.NODE_ENV === "production",
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

// Apply rate limiting to login endpoint (POST only)
router.post("/login", loginLimiter);

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
