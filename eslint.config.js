import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .claude/worktrees/ holds gitignored Claude Code auxiliary worktree copies
  // of the repo; without this ignore, local lint double-reports their contents.
  { ignores: ["dist", "dist-extension", ".claude/worktrees/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // The Chrome extension is browser code but not React code, and it runs with
  // the `chrome` namespace in scope. This block refines the one above rather
  // than replacing it — flat config merges, so the base TypeScript rules still
  // apply — and only adjusts the two things that differ: the React rules have
  // nothing to say about files with no components or hooks, and `chrome` must
  // read as a declared global rather than an undefined name.
  {
    files: ["extension/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-refresh/only-export-components": "off",
    },
  },
);
