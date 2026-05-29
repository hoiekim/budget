import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface ModuleConfig {
  pattern: string | string[];
  preload: string[];
}

export interface CoverageConfig {
  include: string[];
  exclude: string[];
}

export interface WatchConfig {
  ignore: string[];
}

export interface Config {
  modules: Record<string, ModuleConfig>;
  parallelism: number | "auto";
  coverage: CoverageConfig;
  watch: WatchConfig;
}

export const defaultConfig: Config = {
  modules: {},
  parallelism: "auto",
  coverage: { include: ["src/**"], exclude: ["**/*.test.ts", "**/*.test.tsx"] },
  watch: { ignore: ["**/node_modules/**", "**/build/**", "**/.git/**"] },
};

export const loadConfig = async (repoRoot: string): Promise<Config> => {
  const configPath = resolve(repoRoot, "test.config.ts");
  if (!existsSync(configPath)) return defaultConfig;
  const mod = await import(pathToFileURL(configPath).href);
  const loaded = mod.default as Partial<Config> | undefined;
  if (!loaded) return defaultConfig;
  return {
    modules: loaded.modules ?? defaultConfig.modules,
    parallelism: loaded.parallelism ?? defaultConfig.parallelism,
    coverage: { ...defaultConfig.coverage, ...loaded.coverage },
    watch: { ...defaultConfig.watch, ...loaded.watch },
  };
};

export const resolveParallelism = (p: number | "auto"): number => {
  if (p === "auto") return Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(1, p);
};
