import { optionValues } from "../surveys/helpers";
import type { Question } from "../surveys/schema";
import { NOT_ANSWERED, NOT_FINISHED, type Tone } from "./report";

/**
 * What ops may do with a call in Ops → Calls, and how what they type is checked (spec §5.4). Pure.
 *
 * - Approve: a call held for review counts in the index.
 * - Exclude: a call never counts.
 * - Fix an answer: one answer is corrected (kept as an append-only override with its reason), and
 *   the call's checks run again from the stored execution.
 */

export type QaState = "pending" | "auto_ok" | "needs_review" | "approved" | "excluded";
export const REVIEW_DECISIONS = ["approved", "excluded"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const QA_LABEL: Record<QaState, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "neutral" },
  auto_ok: { label: "Counts", tone: "good" },
  needs_review: { label: "Needs review", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  excluded: { label: "Excluded", tone: "bad" },
};

/**
 * The decisions worth offering for a call in this state. Approve is only for a call that isn't
 * counting (held, or excluded and being put back); a call that passed its checks already counts.
 */
export function reviewDecisions(qaState: QaState): readonly ReviewDecision[] {
  if (qaState === "needs_review") return ["approved", "excluded"];
  return qaState === "excluded" ? ["approved"] : ["excluded"];
}

/** A call that ended with the dealer talking: the only kind with answers to check. */
export function reviewable(call: { derivedStatus: string; statusRank: number }): boolean {
  return call.statusRank >= 10 && !NOT_ANSWERED.has(call.derivedStatus) && !NOT_FINISHED.has(call.derivedStatus);
}

/**
 * A call whose answers can be corrected: reviewable, and with the execution stored (the checks
 * run again from it).
 */
export function correctable(call: {
  derivedStatus: string;
  statusRank: number;
  hasRawExecution: boolean;
}): boolean {
  return reviewable(call) && call.hasRawExecution;
}

/** What ops types for "not answered" (the answer is removed; the call keeps the agent's reading). */
export const NOT_ANSWERED_INPUT = "not_answered";

export type ParsedCorrection = { ok: true; value: string | number | null } | { ok: false; error: string };

/** Checks a corrected answer against its question. */
export function parseCorrection(question: Question, input: string): ParsedCorrection {
  const raw = input.trim();
  if (raw === NOT_ANSWERED_INPUT) return { ok: true, value: null };
  if (raw === "") return { ok: false, error: "Enter the answer, or choose “Not answered”." };
  switch (question.type) {
    case "number": {
      const cleaned = raw.replace(/[,\s]/g, "");
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: false, error: "Enter a number." };
      const n = question.integer ? Math.round(Number(cleaned)) : Number(cleaned);
      if (n < question.min || n > question.max) {
        return { ok: false, error: `Must be between ${question.min} and ${question.max}.` };
      }
      return { ok: true, value: n };
    }
    case "text":
      return raw.length > question.maxLength
        ? { ok: false, error: `At most ${question.maxLength} characters.` }
        : { ok: true, value: raw };
    default: {
      const options = optionValues(question) ?? [];
      const v = raw.toLowerCase();
      return options.includes(v) ? { ok: true, value: v } : { ok: false, error: `Choose one of: ${options.join(", ")}.` };
    }
  }
}
