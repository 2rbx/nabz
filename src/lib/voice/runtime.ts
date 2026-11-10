import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClaudeClient, type ClaudeClient } from "../claude/client";
import { voiceEnv } from "../env";
import { createGnaniClient, type GnaniClient } from "../gnani/client";
import { createBudget, EMPTY_BUDGET, type Budget, type BudgetState, type BudgetStore } from "./budget";

/**
 * The app's voice stack, configured from the environment: the Gnani and Claude clients, both behind one
 * spend guard whose totals live in `.voice-budget.local.json`, so the caps hold across restarts, scripts
 * and the app. Not committed. Delete the file only to start a fresh budget on purpose.
 */

export const BUDGET_FILE = ".voice-budget.local.json";

export function fileBudgetStore(file = resolve(process.cwd(), BUDGET_FILE)): BudgetStore {
  return {
    load(): BudgetState {
      if (!existsSync(file)) return { ...EMPTY_BUDGET };
      return { ...EMPTY_BUDGET, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<BudgetState>) };
    },
    save(state) {
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}

export type Voice = { budget: Budget; gnani: GnaniClient; claude: ClaudeClient };

/** Null when either key is missing: the voice agent is then simply unavailable. */
export function voiceFromEnv(): Voice | null {
  const config = voiceEnv();
  if (!config.GNANI_API_KEY || !config.CLAUDE_API_KEY) return null;
  const budget = createBudget(fileBudgetStore());
  return {
    budget,
    gnani: createGnaniClient({ apiKey: config.GNANI_API_KEY, budget }),
    claude: createClaudeClient({ apiKey: config.CLAUDE_API_KEY, budget }),
  };
}

export const AUDIO_CACHE_DIR = ".voice-cache";

/**
 * The agent's speech as base64 MP3. The same words in the same language and voice are generated once
 * and replayed from `.voice-cache/`, which costs no credits (the opening line, repeated phrases, the demo).
 */
export async function speak(
  voice: Pick<Voice, "gnani">,
  text: string,
  language: string,
  voiceName = "Nalini",
): Promise<{ audioBase64: string; cached: boolean }> {
  const key = createHash("sha256").update(`${language}|${voiceName}|${text}`).digest("hex").slice(0, 24);
  const file = resolve(process.cwd(), AUDIO_CACHE_DIR, `${key}.mp3`);
  if (existsSync(file)) return { audioBase64: readFileSync(file).toString("base64"), cached: true };
  const spoken = await voice.gnani.tts({ text, language, voice: voiceName, container: "mp3" });
  mkdirSync(resolve(process.cwd(), AUDIO_CACHE_DIR), { recursive: true });
  writeFileSync(file, spoken.audio);
  return { audioBase64: Buffer.from(spoken.audio).toString("base64"), cached: false };
}
