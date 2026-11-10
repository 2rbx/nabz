import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Ids of agents made by `pnpm agents:create`, used instead of the registry's. Not committed. */
export const AGENTS_LOCAL_FILE = "agents.local.json";

/**
 * Loads .env.local for scripts (Next.js does this itself for the app). Values already present in the
 * environment win, so a caller can always override, e.g. DATABASE_URL for the test database.
 */
export function loadLocalEnv(file = ".env.local"): void {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
  // Keys placed in plain .env (the Gnani and Claude keys) are read too; .env.local, loaded first, wins.
  const plain = resolve(process.cwd(), ".env");
  if (file === ".env.local" && existsSync(plain)) process.loadEnvFile(plain);
}

/** Runs an async script, reporting failures with a non-zero exit code. */
export function runScript(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `\n✖ ${error.message}` : error);
    process.exitCode = 1;
  });
}
