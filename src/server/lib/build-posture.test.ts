import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

// The production posture (Secure session cookie, HSTS header) is selected
// by NODE_ENV at bundle time: Bun.build folds process.env.NODE_ENV into a
// constant, so the value present when the bundle is built is the value
// that ships, and no runtime environment can change it. These pins keep
// the two halves of that from silently converging again:
//
// - the Dockerfile builder stage must declare the knob with an EMPTY
//   default (a production default would bake a posture into every
//   artifact built from the repo, including local ones), and pass it
//   through to the build step;
// - the CD pipeline, which builds the published image, must pass
//   NODE_ENV=production, or the published image ships the
//   non-production posture;
// - the bundle built with NODE_ENV=production must actually fold to the
//   production posture, and the bundle built without it must not —
//   verified against the real entrypoint via a child process, because
//   Bun.build reads the environment it started with.
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
const cdWorkflow = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/cd.yml"),
  "utf8",
);

const runProbe = (nodeEnv: string | undefined): string => {
  const env = { ...process.env };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  const proc = Bun.spawnSync(
    ["bun", path.join(REPO_ROOT, "scripts/build-posture-probe.ts")],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString("utf8").trim();
};

describe("build posture", () => {
  it("declares an empty-default NODE_ENV build arg and passes it to the build step", () => {
    const builderStage = dockerfile.split(/^FROM /m)[1];
    expect(builderStage).toContain("ARG NODE_ENV=");
    expect(builderStage).not.toContain("ARG NODE_ENV=production");
    const argAt = builderStage.indexOf("ARG NODE_ENV=");
    const envAt = builderStage.indexOf("ENV NODE_ENV=${NODE_ENV}");
    const buildAt = builderStage.indexOf("RUN bun run build");
    expect(envAt).toBeGreaterThan(argAt);
    expect(buildAt).toBeGreaterThan(envAt);
  });

  it("builds the published image with NODE_ENV=production", () => {
    expect(cdWorkflow).toContain("NODE_ENV=production");
  });

  it("folds NODE_ENV=production into the production posture", () => {
    expect(runProbe("production")).toBe("logger=true start=true");
  });

  it("folds an unset NODE_ENV into the non-production posture", () => {
    expect(runProbe(undefined)).toBe("logger=false start=false");
  });

  it("folds an empty NODE_ENV into the non-production posture", () => {
    expect(runProbe("")).toBe("logger=false start=false");
  });
});
