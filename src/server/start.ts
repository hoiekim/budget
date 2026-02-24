import { importConfig, setModulePaths, overrideConsoleLog } from "./config";
importConfig();
setModulePaths();
overrideConsoleLog();

import path from "path";
import express, { Router } from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { initializePostgres, PostgresSessionStore, scheduledSync } from "server";
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
    store: new PostgresSessionStore(),
  }),
);

// Rate limiter for login endpoint: 5 attempts per 15 minutes per IP
// skipSuccessfulRequests allows legitimate users to continue after successful login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  message: { status: "failed", message: "Too many login attempts, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

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
