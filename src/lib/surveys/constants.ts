/** QA flags the platform computes for every survey. Survey-specific rules may not reuse these codes. */
export const PLATFORM_QA_CODES = [
  "too_short",
  "invalid_answer",
  "out_of_range",
  "low_confidence",
  "false_completed",
  "missing_answers",
  // Set by ingestion, not evaluateQa: the agent returned no extraction for a real conversation.
  "extraction_missing",
  // Set by ingestion: the agent's extraction was empty and the answers were re-read from the transcript.
  "reextracted",
] as const;

/** Keys the platform owns on every call. Questions may not use them. */
export const RESERVED_KEYS = ["outcome", "callback_time"] as const;

export const SEVERITIES = ["hold", "warn", "info", "exclude"] as const;
