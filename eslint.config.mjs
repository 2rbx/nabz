import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Modules that must stay pure: no database, env, Next.js or driver imports.
// They are shared by the app, scripts and tests, and are unit-tested in isolation.
const PURE_DIRS = [
  "src/lib/domain/**",
  "src/lib/reference/**",
  "src/lib/sectors/**",
  "src/lib/surveys/**",
  "src/lib/index/**",
  "src/lib/calls/**",
  "src/lib/batches/**",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Environment variables are read in exactly one place: src/lib/env.ts.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/env.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read configuration through @/lib/env, never process.env directly.",
        },
      ],
    },
  },
  {
    // Gnani and Claude are reachable only through their guarded clients, which check the spend caps.
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
    ignores: ["src/lib/gnani/**", "src/lib/claude/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/api\\.vachana\\.ai|api\\.anthropic\\.com/i]",
          message: "Gnani and Claude are only reachable through src/lib/gnani and src/lib/claude (the budget guards).",
        },
        {
          selector: "TemplateElement[value.raw=/api\\.vachana\\.ai|api\\.anthropic\\.com/i]",
          message: "Gnani and Claude are only reachable through src/lib/gnani and src/lib/claude (the budget guards).",
        },
      ],
    },
  },
  {
    files: PURE_DIRS.map((dir) => `${dir.replace("/**", "")}/**/*.{ts,tsx}`),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/lib/db", "@/lib/db/*"], message: "Pure modules must not touch the database." },
            { group: ["@/lib/env"], message: "Pure modules must not read configuration." },
            { group: ["next", "next/*"], message: "Pure modules must not depend on Next.js." },
            {
              group: ["pg", "drizzle-orm", "drizzle-orm/*"],
              message: "Pure modules must not import database drivers.",
            },
            { group: ["server-only"], message: "Pure modules are shared with scripts and tests." },
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "drizzle/**", "coverage/**"]),
]);

export default eslintConfig;
