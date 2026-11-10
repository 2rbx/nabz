/**
 * The spend guard for the Gnani voice agent. Pure: storage is passed in, so the same rules run in the
 * app, scripts and tests.
 *
 * Two hard limits (owner's rules, 10 Nov 2026):
 * - Claude API usage stays between $5 and $10. The cap here is $9, so one call that overshoots
 *   still lands under $10.
 * - Gnani gives 5,000 programme credits in total. The cap here is 4,000 (80%), so a wrong rate
 *   can't empty the account.
 *
 * Every Claude and Gnani call goes through `charge*` after it answers and `ensure*` before it is sent.
 * `ensure*` throws `BudgetExceeded` when the worst case would pass the cap, so nothing is sent.
 */

export const BUDGET_LIMITS = {
  claudeCapUsd: 9,
  gnaniCapCredits: 4000,
} as const;

/** Claude prices, US$ per million tokens (Anthropic price table, 3 Nov 2026; Haiku is for prompts up to 100K). */
export const CLAUDE_PRICES = {
  "claude-haiku-5-5": { inputPerM: 0.1, outputPerM: 0.5 },
  "claude-sonnet-5-5": { inputPerM: 2, outputPerM: 10 },
} as const;
export type ClaudeModel = keyof typeof CLAUDE_PRICES;

/**
 * Gnani rates from the dashboard ("5,000 credits ≈ 15,000 min of STT or ≈ 27.8 lakh characters of TTS"),
 * padded by 25% so estimates are never low. Replace with the measured rates after the first real calls.
 */
const SAFETY = 1.25;
export const GNANI_RATES = {
  sttCreditsPerMinute: (5000 / 15000) * SAFETY,
  ttsCreditsPerChar: (5000 / 2_780_000) * SAFETY,
} as const;

export type BudgetState = {
  claudeUsd: number;
  gnaniCredits: number;
  claudeCalls: number;
  sttSeconds: number;
  ttsChars: number;
};

export const EMPTY_BUDGET: BudgetState = { claudeUsd: 0, gnaniCredits: 0, claudeCalls: 0, sttSeconds: 0, ttsChars: 0 };

export type BudgetStore = {
  load(): BudgetState;
  save(state: BudgetState): void;
};

export class BudgetExceeded extends Error {
  constructor(
    readonly resource: "claude" | "gnani",
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

export type Usage = { inputTokens: number; outputTokens: number };

export function claudeCostUsd(model: ClaudeModel, usage: Usage): number {
  const p = CLAUDE_PRICES[model];
  return (usage.inputTokens * p.inputPerM + usage.outputTokens * p.outputPerM) / 1_000_000;
}

export function sttCostCredits(seconds: number): number {
  return (seconds / 60) * GNANI_RATES.sttCreditsPerMinute;
}

export function ttsCostCredits(chars: number): number {
  return chars * GNANI_RATES.ttsCreditsPerChar;
}

export function createBudget(store: BudgetStore, limits: { claudeCapUsd: number; gnaniCapCredits: number } = BUDGET_LIMITS) {
  const refuseClaude = (state: BudgetState, extra: number) => {
    if (state.claudeUsd + extra > limits.claudeCapUsd) {
      throw new BudgetExceeded(
        "claude",
        `Claude budget reached: $${state.claudeUsd.toFixed(3)} spent of the $${limits.claudeCapUsd} cap. Nothing was sent.`,
      );
    }
  };
  const refuseGnani = (state: BudgetState, extra: number) => {
    if (state.gnaniCredits + extra > limits.gnaniCapCredits) {
      throw new BudgetExceeded(
        "gnani",
        `Gnani credit budget reached: ${state.gnaniCredits.toFixed(1)} used of the ${limits.gnaniCapCredits}-credit cap. Nothing was sent.`,
      );
    }
  };

  return {
    state: () => store.load(),

    /** Before a Claude call: refuses when the worst case (all of `maxTokens` as output) would pass the cap. */
    ensureClaude(model: ClaudeModel, inputTokensEstimate: number, maxOutputTokens: number): void {
      refuseClaude(store.load(), claudeCostUsd(model, { inputTokens: inputTokensEstimate, outputTokens: maxOutputTokens }));
    },
    /** After a Claude call, with the real token counts from the response. */
    chargeClaude(model: ClaudeModel, usage: Usage): number {
      const cost = claudeCostUsd(model, usage);
      const s = store.load();
      store.save({ ...s, claudeUsd: s.claudeUsd + cost, claudeCalls: s.claudeCalls + 1 });
      return cost;
    },

    ensureStt(seconds: number): void {
      refuseGnani(store.load(), sttCostCredits(seconds));
    },
    chargeStt(seconds: number): number {
      const cost = sttCostCredits(seconds);
      const s = store.load();
      store.save({ ...s, gnaniCredits: s.gnaniCredits + cost, sttSeconds: s.sttSeconds + seconds });
      return cost;
    },

    ensureTts(chars: number): void {
      refuseGnani(store.load(), ttsCostCredits(chars));
    },
    chargeTts(chars: number): number {
      const cost = ttsCostCredits(chars);
      const s = store.load();
      store.save({ ...s, gnaniCredits: s.gnaniCredits + cost, ttsChars: s.ttsChars + chars });
      return cost;
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;

/** An in-memory store, for tests. */
export function memoryStore(initial: BudgetState = EMPTY_BUDGET): BudgetStore & { current: BudgetState } {
  const box = { current: initial };
  return {
    get current() {
      return box.current;
    },
    load: () => box.current,
    save: (s) => {
      box.current = s;
    },
  } as BudgetStore & { current: BudgetState };
}
