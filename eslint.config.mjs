import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    // `.worktrees/*` are full checkouts of this repo (AGENTS.md recommends one
    // for production-build testing). Without this they are linted a second
    // time and every finding is reported twice.
    ignores: [".worktrees/**"],
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // `components/**` is browser code ("use client"): the `Bun` global does
    // not exist there, and referencing it unmounts the whole app at runtime
    // (#154). Server-side matching lives in `lib/` / `app/`.
    files: ["components/**/*.{ts,tsx}"],
    ignores: ["components/**/*.test.{ts,tsx,mjs}"],
    rules: {
      "no-restricted-globals": ["error", { name: "Bun", message: "The Bun global is not available in browser code." }],
    },
  },
];

export default eslintConfig;
