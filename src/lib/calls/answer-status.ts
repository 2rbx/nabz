import {
  type AnswerStatus,
  type MissingReason,
  MISSING_REASONS,
  type Outcome,
} from "../domain/constants";
import type { Answers } from "../index/score";
import type { StoredExtraction } from "./report";

/**
 * Per-question answer status: an answer, or the reason there isn't one. Pure, shared by ingestion,
 * QA, the call pop-up and the ops answer rates.
 *
 * The rule (owner's decision, 2026-10-27): keep every real answer, leave out only the missing ones,
 * and record why each one is missing. `answers` holds real answers only (the index reads nothing
 * else); the reason lives in `extracted[key].status`.
 */

export const ANSWER_STATUS_LABEL: Record<AnswerStatus, string> = {
  answered: "Answered",
  dont_know: "Didn't know",
  declined: "Declined",
  not_asked: "Not asked",
  unclear: "Unclear",
};

/** The suffix of the companion field that carries a number question's status. */
export const STATUS_FIELD_SUFFIX = "_status";

const REASONS = new Set<string>(MISSING_REASONS);

/** Reads a missing reason from a raw extraction value (e.g. the agent's objective option). */
export function parseMissingReason(raw: unknown): MissingReason | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return REASONS.has(v) ? (v as MissingReason) : null;
}

/**
 * The status of one question on a call. An effective answer always wins (an ops correction can
 * fill a gap). Without one, the stored reason; for calls stored before reasons existed, a failed
 * validation reads as "unclear" and anything else as "not asked".
 */
export function answerStatus(
  answers: Answers,
  extracted: Readonly<Record<string, StoredExtraction>>,
  key: string,
): AnswerStatus {
  const a = answers[key];
  if (a !== undefined && a !== "") return "answered";
  const ex = extracted[key];
  if (ex?.status && ex.status !== "answered") return ex.status;
  if (ex?.valid === false) return "unclear";
  return "not_asked";
}

/**
 * Whether a conversation got through the survey. Completed: every index question was asked and the
 * dealer responded, where "didn't know" and "declined" count as responses. Partial: the call ended
 * or stopped before every question was asked. Usability is separate: a call still needs
 * `minAnsweredForUsable` real answers to count.
 */
export function surveyOutcome(statuses: readonly AnswerStatus[]): Extract<Outcome, "completed" | "partial"> {
  return statuses.some((s) => s === "not_asked") ? "partial" : "completed";
}
