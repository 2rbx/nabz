/**
 * Shared vocabularies. Database CHECK constraints are generated from these same arrays,
 * so the TypeScript types and the database can never disagree.
 */

/** What happened on a call, as extracted by the voice agent. Owned by the platform, not by surveys. */
export const OUTCOMES = ["completed", "partial", "refused", "callback", "wrong_number"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * A word the frozen survey versions and their voice agents can still return. To us it's a refusal
 * (src/lib/calls/ingest/fields.ts), never a status of its own.
 */
export const AGENT_ONLY_OUTCOME = "opted_out";

/**
 * Why a question has no answer, as the extraction reports it. Owned by the platform: every survey's
 * questions get the same reasons, so "didn't know" means the same thing everywhere.
 */
export const MISSING_REASONS = ["dont_know", "declined", "not_asked"] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

/**
 * What happened to one question on a call. Only "answered" values reach the index; the rest say why
 * not. "unclear" is ours: something came back but failed validation (not an allowed option, not a
 * number, out of range).
 */
export const ANSWER_STATUSES = ["answered", ...MISSING_REASONS, "unclear"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/**
 * Our status for a call (spec §5.3): where it is in its life, or how it ended. Derived from the agent's
 * status and, for real conversations, from what the dealer answered (src/lib/calls/ingest/status.ts).
 */
export const DERIVED_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "partial",
  "refused",
  "callback",
  "wrong_number",
  "no_answer",
  "busy",
  "failed",
  "voicemail",
  "error",
] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

/**
 * Where a call's answers came from: the agent's own extraction, or our fallback re-reading the stored
 * transcript with the same agent's extractions when the agent's came back empty.
 */
export const EXTRACTION_SOURCES = ["agent", "reextract"] as const;
export type ExtractionSource = (typeof EXTRACTION_SOURCES)[number];

export const TREND_VALUES = ["up", "same", "down"] as const;
export const LEVEL_VALUES = ["high", "normal", "low"] as const;

/** India Standard Time. Fixed UTC+05:30, no daylight saving, so offsets are plain arithmetic. */
export const IST_OFFSET_MINUTES = 330;

