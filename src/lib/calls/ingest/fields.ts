import { AGENT_ONLY_OUTCOME, type AnswerStatus, OUTCOMES, type Outcome } from "../../domain/constants";
import type { Answers } from "../../index/score";
import { extractionName, optionValues } from "../../surveys/helpers";
import type { Question, SurveyDefinition } from "../../surveys/schema";
import { parseMissingReason, STATUS_FIELD_SUFFIX } from "../answer-status";
import type { StoredExtraction } from "../report";

/**
 * Reads the agent's extraction for one call into our per-question answers. Pure.
 *
 * The extraction puts every field in `extracted_data.Pulse.<name>` as
 * `{ objective, subjective, confidence, validation: { is_valid } }`: pre-defined (choice) fields
 * answer in `objective`, free-text and numeric fields in `subjective`, and every numeric field has a
 * pre-defined `<name>_status` companion saying why it's empty (spec §5.1).
 *
 * The rule (answer-status.ts): `answers` holds real answers only; every question also gets an
 * `extracted` entry saying what came back and, if it isn't an answer, why. A value that came back
 * but fails our checks is "unclear" with `valid: false` (QA holds the call for a person to look at);
 * an explicit reason, or nothing at all, is never a failed value.
 */

/** One extraction field, as far as we read it. */
type PulseField = {
  objective?: unknown;
  subjective?: unknown;
  confidence?: unknown;
  validation?: { is_valid?: unknown } | null;
};

export type ReadPulse = {
  extracted: Record<string, StoredExtraction>;
  answers: Answers;
  /** The outcome extraction, if it named a known outcome. */
  outcome: Outcome | null;
  /** When the dealer asked to be called back, in their words. */
  callbackTime: string | null;
  /** True when the agent returned no Pulse fields at all (its extraction didn't run). */
  empty: boolean;
};

const OUTCOME_SET = new Set<string>(OUTCOMES);

const readOutcome = (raw: string) => (raw === AGENT_ONLY_OUTCOME ? "refused" : raw);

function field(pulse: Record<string, unknown>, name: string): PulseField | null {
  const f = pulse[name];
  return f && typeof f === "object" ? (f as PulseField) : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function confidenceOf(f: PulseField | null): number | null {
  return typeof f?.confidence === "number" && Number.isFinite(f.confidence) ? f.confidence : null;
}

/**
 * A reason word in place of an answer: our three missing reasons, the agent's "unclear", and v01's
 * legacy "not_answered" (which meant the same as not asked).
 */
function reasonOf(raw: string): Exclude<AnswerStatus, "answered"> | null {
  const v = raw.toLowerCase();
  if (v === "unclear") return "unclear";
  if (v === "not_answered") return "not_asked";
  return parseMissingReason(v);
}

const missing = (status: Exclude<AnswerStatus, "answered">, raw: unknown = null): StoredExtraction => ({
  raw,
  value: null,
  confidence: null,
  valid: null,
  status,
});

const failed = (raw: unknown): StoredExtraction => ({
  raw,
  value: null,
  confidence: null,
  valid: false,
  status: "unclear",
});

function readChoice(q: Question, f: PulseField | null): StoredExtraction {
  const raw = text(f?.objective);
  if (raw === "") return missing("not_asked");
  const v = raw.toLowerCase();
  const reason = reasonOf(v);
  if (reason) return missing(reason, raw);
  if (optionValues(q)?.includes(v)) {
    return { raw, value: v, confidence: confidenceOf(f), valid: true, status: "answered" };
  }
  return failed(raw);
}

/** "1,200" → 1200, "12.6" → 12.6; anything that isn't a plain number → null. */
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function readNumber(q: Extract<Question, { type: "number" }>, f: PulseField | null, companion: PulseField | null): StoredExtraction {
  const raw = text(f?.subjective);
  if (raw === "") {
    // Empty: the companion says why. A garble that never produced a value is "unclear" too, but
    // not a failed value, so it doesn't hold the call.
    return missing(reasonOf(text(companion?.objective)) ?? "not_asked");
  }
  const reason = reasonOf(raw);
  if (reason) return missing(reason, raw);
  const n = parseNumber(raw);
  if (n === null || f?.validation?.is_valid === false) return failed(raw);
  const value = q.integer ? Math.round(n) : n;
  if (value < q.min || value > q.max) return failed(raw);
  return { raw, value, confidence: confidenceOf(f), valid: true, status: "answered" };
}

function readText(f: PulseField | null): StoredExtraction {
  const raw = text(f?.subjective);
  if (raw === "") return missing("not_asked");
  const reason = reasonOf(raw);
  if (reason) return missing(reason, raw);
  return { raw, value: raw, confidence: confidenceOf(f), valid: true, status: "answered" };
}

export function readPulse(definition: SurveyDefinition, extractedData: unknown): ReadPulse {
  const data = extractedData && typeof extractedData === "object" ? (extractedData as Record<string, unknown>) : {};
  const pulse = data.Pulse && typeof data.Pulse === "object" ? (data.Pulse as Record<string, unknown>) : {};
  const extracted: Record<string, StoredExtraction> = {};
  const answers: Record<string, string | number> = {};

  for (const q of definition.questions) {
    const name = extractionName(q);
    const f = field(pulse, name);
    const entry =
      q.type === "number"
        ? readNumber(q, f, field(pulse, `${name}${STATUS_FIELD_SUFFIX}`))
        : q.type === "text"
          ? readText(f)
          : readChoice(q, f);
    extracted[q.key] = entry;
    if (entry.status === "answered" && entry.value !== null) answers[q.key] = entry.value;
  }

  const outcomeField = field(pulse, "outcome");
  const outcomeRaw = text(outcomeField?.objective).toLowerCase();
  const outcomeRead = readOutcome(outcomeRaw);
  const outcome = OUTCOME_SET.has(outcomeRead) ? (outcomeRead as Outcome) : null;
  if (outcomeRaw) {
    extracted.outcome = outcome
      ? { raw: outcomeRaw, value: outcome, confidence: confidenceOf(outcomeField), valid: true }
      : { raw: outcomeRaw, value: null, confidence: null, valid: false };
  }

  const callbackField = field(pulse, "callback_time");
  const callbackTime = text(callbackField?.subjective) || null;
  if (callbackTime) {
    extracted.callback_time = { raw: callbackTime, value: callbackTime, confidence: confidenceOf(callbackField), valid: true };
  }

  return { extracted, answers, outcome, callbackTime, empty: Object.keys(pulse).length === 0 };
}
