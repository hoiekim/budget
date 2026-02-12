import path from "path";
import fs from "fs";

const root = path.resolve(import.meta.dir, "..");

async function bundle() {
  const result = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "start.ts")],
    outdir: path.resolve(root, "..", "build", "server"),
    target: "bun",
    external: ["bcrypt", "pg", "plaid"],
    minify: false,
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Rename output to bundle.js
  const outputPath = path.resolve(root, "..", "build", "server");
  const files = fs.readdirSync(outputPath);
  const jsFile = files.find((f) => f.endsWith(".js") && f !== "bundle.js");
  if (jsFile) {
    fs.renameSync(
      path.resolve(outputPath, jsFile),
      path.resolve(outputPath, "bundle.js")
    );
  }

  console.info("Bun build succeeded to compile server.");
}

bundle();
