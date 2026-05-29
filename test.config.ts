/**
 * Root config for the custom test runner (`scripts/test-runner`).
 *
 * Modules group test files by glob; each group has its own preload list.
 * A test file inherits its group's preload, plus any per-file additions from
 * a `// @test preload=…` header (see scripts/test-runner/discover.ts).
 *
 * Files outside every module pattern are still discovered and run, just
 * with no module-level preload (the per-file header still applies).
 */
import type { Config } from "./scripts/test-runner/config.ts";

const config: Config = {
  modules: {
    client: {
      pattern: ["src/client/**/*.test.ts", "src/client/**/*.test.tsx"],
      preload: ["src/client/test-setup.ts"],
    },
    server: {
      pattern: ["src/server/**/*.test.ts"],
      preload: [],
    },
    common: {
      pattern: ["src/common/**/*.test.ts"],
      preload: [],
    },
  },
  parallelism: "auto",
  coverage: {
    include: ["src/**"],
    exclude: ["**/*.test.ts", "**/*.test.tsx", "**/__fixtures__/**", "**/test-setup.ts"],
  },
  watch: {
    ignore: [
      "**/node_modules/**",
      "**/build/**",
      "**/coverage/**",
      "**/.git/**",
      "**/.cache/**",
      "**/*.log",
    ],
  },
};

export default config;
