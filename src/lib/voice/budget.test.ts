import { describe, expect, it } from "vitest";
import {
  BudgetExceeded,
  BUDGET_LIMITS,
  claudeCostUsd,
  createBudget,
  EMPTY_BUDGET,
  GNANI_RATES,
  memoryStore,
  sttCostCredits,
  ttsCostCredits,
} from "./budget";

describe("costs", () => {
  it("prices Claude from real token counts", () => {
    // Haiku 5.5: $0.10 in, $0.50 out per million tokens.
    expect(claudeCostUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6);
    expect(claudeCostUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(12);
  });

  it("never estimates Gnani below the dashboard's rate", () => {
    // 5,000 credits is about 15,000 STT minutes and 2.78M TTS characters.
    expect(GNANI_RATES.sttCreditsPerMinute).toBeGreaterThan(5000 / 15000);
    expect(GNANI_RATES.ttsCreditsPerChar).toBeGreaterThan(5000 / 2_780_000);
    expect(sttCostCredits(15000 * 60)).toBeGreaterThan(5000);
    expect(ttsCostCredits(2_780_000)).toBeGreaterThan(5000);
  });
});

describe("the Claude cap", () => {
  it("keeps total spend under $10 and refuses before sending", () => {
    expect(BUDGET_LIMITS.claudeCapUsd).toBeLessThan(10);
    const store = memoryStore({ ...EMPTY_BUDGET, claudeUsd: 8.995 });
    const budget = createBudget(store);
    // 1,000 output tokens on Sonnet is $0.01: the worst case passes $9.
    expect(() => budget.ensureClaude("claude-sonnet-5-5", 0, 1000)).toThrow(BudgetExceeded);
    expect(() => budget.ensureClaude("claude-haiku-5-5", 1000, 100)).not.toThrow();
  });

  it("records the cost and the call count", () => {
    const store = memoryStore();
    const budget = createBudget(store);
    const cost = budget.chargeClaude("claude-haiku-5-5", { inputTokens: 2000, outputTokens: 300 });
    expect(cost).toBeCloseTo(0.00035);
    expect(store.current.claudeUsd).toBeCloseTo(0.00035);
    expect(store.current.claudeCalls).toBe(1);
  });
});

describe("the Gnani cap", () => {
  it("stays at or below 80% of the 5,000 credits", () => {
    expect(BUDGET_LIMITS.gnaniCapCredits).toBeLessThanOrEqual(4000);
  });

  it("refuses STT and TTS that would pass the cap", () => {
    const store = memoryStore({ ...EMPTY_BUDGET, gnaniCredits: 3999.5 });
    const budget = createBudget(store);
    expect(() => budget.ensureStt(120)).toThrow(BudgetExceeded);
    expect(() => budget.ensureTts(600)).toThrow(BudgetExceeded);
    expect(() => budget.ensureTts(10)).not.toThrow();
  });

  it("adds credits and usage as calls happen", () => {
    const store = memoryStore();
    const budget = createBudget(store);
    budget.chargeStt(60);
    budget.chargeTts(1000);
    expect(store.current.sttSeconds).toBe(60);
    expect(store.current.ttsChars).toBe(1000);
    expect(store.current.gnaniCredits).toBeCloseTo(sttCostCredits(60) + ttsCostCredits(1000));
  });
});
