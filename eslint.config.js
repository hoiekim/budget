import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

export default [
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
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
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",

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
      "prefer-const": "warn",
    },
  },
  {
    ignores: ["build/**", "node_modules/**", "coverage/**", "*.config.js"],
  },
];
