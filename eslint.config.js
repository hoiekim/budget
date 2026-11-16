import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

export default [
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts", "scripts/**/*.tsx", "vite.config.ts", "healthcheck.js"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // TypeScript-specific rules
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",

      // Disable base rules that conflict with TypeScript
      "no-unused-vars": "off",
      "no-undef": "off", // TypeScript handles this

      // From eslint:recommended but applicable
      "no-extra-boolean-cast": "error",
      "no-async-promise-executor": "error",
      "no-case-declarations": "error",
      "no-prototype-builtins": "error",

      // Helpful rules
      "no-console": "off", // Allow console
      "prefer-const": "error",
    },
  },
  {
    // Issue 847: the Plaid Node SDK must not reach the browser bundle. The client
    // and common layers take their Plaid enums from src/common/lib/plaid-enums
    // (and the interfaces as types from there); only that module may import
    // "plaid", as a type-only re-export. A future value import fails lint
    // here instead of silently adding 400 kB to every page load.
    files: ["src/client/**/*.ts", "src/client/**/*.tsx", "src/common/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "plaid",
              message:
                'Import Plaid enums from "common/lib/plaid-enums" instead — a value import of the SDK pulls plaid + axios into the browser bundle (issue 847).',
            },
          ],
        },
      ],
    },
  },
  {
    // The single sanctioned gateway: plaid-enums.ts re-exports the SDK's
    // interfaces as types. Must come after the ban above so it wins.
    files: ["src/common/lib/plaid-enums.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    ignores: ["build/**", "node_modules/**", "coverage/**", "*.config.js"],
  },
];
