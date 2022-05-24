let envPath = ".env";
const { NODE_ENV } = process.env;
if (NODE_ENV) envPath += "." + NODE_ENV;
require("dotenv").config({ path: envPath });

import express from "express";
import session from "express-session";
import path from "path";
import routes from "routes";

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
  console.info("Received API request.");
  console.group();
  const date = new Date();
  const offset = date.getTimezoneOffset() / -60;
  const offsetString = (offset > 0 ? "+" : "") + offset + "H";
  console.info(`<${req.method}> /api${req.url}`);
  console.info(`At: ${date.toLocaleString()}, ${offsetString}`);
  console.info(`From: ${req.ip}`);
  console.groupEnd();
  try {
    next();
  } catch (error) {
    console.error(error);
  }
});

routes.forEach((e) => router.use(e.path, e.handler));

app.use("/api", router);

const clientPath = path.resolve(__dirname, "../../build");
app.use(express.static(clientPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.listen(process.env.PORT || 3005, () => {
  console.info("Budget app server is up.");
});
