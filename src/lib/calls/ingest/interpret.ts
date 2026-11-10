import type { VoiceExecution } from "../execution";
import type { DerivedStatus, ExtractionSource, Outcome } from "../../domain/constants";
import type { Answers } from "../../index/score";
import { indexQuestionKeys } from "../../surveys/helpers";
import type { SurveyDefinition } from "../../surveys/schema";
import { answerStatus } from "../answer-status";
import { evaluateQa, type QaFlag } from "../qa";
import type { StoredExtraction } from "../report";
import { readPulse } from "./fields";
import { conversationHappened, deriveStatus, isTerminal, statusRank } from "./status";

/**
 * Turns one execution into everything a stored call needs: statuses, times, cost, the
 * answers with the reason for each gap, and QA. Pure: the same execution always gives the same result, which is what makes ingestion safe to replay.
 */

export type InterpretedCall = {
  executionStatus: string;
  statusRank: number;
  terminal: boolean;
  derivedStatus: DerivedStatus;
  outcome: Outcome | null;
  answeredByVoicemail: boolean | null;
  initiatedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The last update of this execution; a later replay only applies if this moved forward. */
  executionUpdatedAt: Date | null;
  durationS: number | null;
  /** US cents, as the wallet is charged (`total_cost`). */
  costCents: number | null;
  costBreakdown: Record<string, unknown> | null;
  hangupBy: string | null;
  hangupReason: string | null;
  errorMessage: string | null;
  transcript: string | null;
  extracted: Record<string, StoredExtraction>;
  answers: Answers;
  answeredCount: number;
  callbackTimeText: string | null;
  qaState: "pending" | "auto_ok" | "needs_review" | "excluded";
  flags: QaFlag[];
  /** Where the answers came from; null when there was no conversation, or nothing came back. */
  extractionSource: ExtractionSource | null;
  /** No extraction at all for a finished conversation (the fallback re-extraction can fix it). */
  extractionMissing: boolean;
};

/**
 * Timestamps: `created_at`/`updated_at` carry an offset, `initiated_at` doesn't (it is UTC,
 * as comparing it with `created_at` shows), so a bare one is read as UTC.
 */
export function parseExecutionTime(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const v = value.trim();
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Applies ops' corrections on top of the extracted answers (null removes an answer). */
export function applyOverrides(answers: Answers, overrides: Readonly<Record<string, string | number | null>>): Answers {
  const out: Record<string, string | number> = { ...answers };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === "") delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * The extraction as ops' corrections leave it, for deciding the call's status and QA (the stored
 * `extracted` stays what the agent returned). A corrected value was checked by a person, so the agent's
 * confidence and validity no longer apply to it; a removed one is unclear (the recording doesn't
 * support it), which is a response, so it doesn't make the call partial.
 */
function withOverrides(
  extracted: Readonly<Record<string, StoredExtraction>>,
  overrides: Readonly<Record<string, string | number | null>>,
): Record<string, StoredExtraction> {
  const out = { ...extracted };
  for (const [key, value] of Object.entries(overrides)) {
    const raw = extracted[key]?.raw ?? null;
    out[key] =
      value === null || value === ""
        ? { raw, value: null, confidence: null, valid: null, status: "unclear" }
        : { raw, value, confidence: null, valid: true, status: "answered" };
  }
  return out;
}

export type InterpretOptions = {
  /** Ops' corrections: the latest per question (null removes an answer). */
  overrides?: Readonly<Record<string, string | number | null>>;
  /** What the fallback re-extraction returned (`extracted_data`), if it ran. */
  reextracted?: unknown;
};

export function interpretExecution(
  definition: SurveyDefinition,
  execution: VoiceExecution,
  previousAnswers: Answers | null,
  { overrides = {}, reextracted = null }: InterpretOptions = {},
): InterpretedCall {
  const status = execution.status;
  const terminal = isTerminal(status);
  const telephony = (execution.telephony_data ?? {}) as Record<string, unknown>;
  const durationS = num(execution.conversation_duration);
  const initiatedAt = parseExecutionTime(execution.initiated_at) ?? parseExecutionTime(execution.created_at) ?? new Date(0);
  const executionUpdatedAt = parseExecutionTime(execution.updated_at);
  const endedAt = terminal ? executionUpdatedAt : null;
  const conversed = terminal && status === "completed" && conversationHappened(execution);
  const startedAt = conversed && endedAt && durationS ? new Date(endedAt.getTime() - durationS * 1000) : null;
  const voicemail = typeof execution.answered_by_voice_mail === "boolean" ? execution.answered_by_voice_mail : null;

  const base = {
    executionStatus: status,
    statusRank: statusRank(status),
    terminal,
    answeredByVoicemail: voicemail,
    initiatedAt,
    startedAt,
    endedAt,
    executionUpdatedAt,
    durationS,
    costCents: num(execution.total_cost),
    costBreakdown: (execution.cost_breakdown as Record<string, unknown> | null | undefined) ?? null,
    hangupBy: str(telephony.hangup_by),
    hangupReason: str(telephony.hangup_reason),
    transcript: str(execution.transcript),
  };

  // Only a real conversation has answers: whatever the voice agent extracts from a call nobody spoke on is a guess.
  // The agent's own extraction wins whenever it has one (including one that arrives late); the fallback's
  // re-reading of the transcript is used only when the agent's came back empty.
  let pulse = readPulse(definition, conversed ? execution.extracted_data : null);
  let extractionSource: ExtractionSource | null = conversed && !pulse.empty ? "agent" : null;
  if (conversed && pulse.empty && reextracted) {
    const fallback = readPulse(definition, reextracted);
    if (!fallback.empty) {
      pulse = fallback;
      extractionSource = "reextract";
    }
  }
  const answers = applyOverrides(pulse.answers, overrides);
  const reviewed = withOverrides(pulse.extracted, overrides);
  const indexKeys = indexQuestionKeys(definition);
  const indexStatuses = indexKeys.map((k) => answerStatus(answers, reviewed, k));
  const answeredIndex = indexStatuses.filter((s) => s === "answered").length;
  const derivedStatus = deriveStatus(execution, {
    indexStatuses,
    answeredIndex,
    outcome: pulse.outcome,
    minAnswered: definition.qa.minAnsweredForUsable,
  });

  if (!terminal) {
    return {
      ...base,
      derivedStatus,
      outcome: null,
      errorMessage: null,
      extracted: {},
      answers: {},
      answeredCount: 0,
      callbackTimeText: null,
      qaState: "pending",
      flags: [],
      extractionSource: null,
      extractionMissing: false,
    };
  }

  const errorMessage =
    derivedStatus === "error" || derivedStatus === "failed"
      ? (str(execution.error_message) ?? str(execution.termination_reason) ?? status)
      : str(execution.error_message);
  const extractionMissing = conversed && pulse.empty;
  const qa = evaluateQa(definition, { derivedStatus, durationS, answers, extracted: reviewed }, previousAnswers);
  const flags = [...qa.flags];
  let qaState: InterpretedCall["qaState"] = qa.qaState;
  if (extractionMissing) {
    flags.push({
      code: "extraction_missing",
      severity: "hold",
      questionKey: null,
      detail: "The agent returned no extraction for this conversation",
    });
    if (qaState === "auto_ok") qaState = "needs_review";
  }
  if (extractionSource === "reextract") {
    // Same extractor, same transcript: the answers count, but the call's data says how they were read.
    flags.push({
      code: "reextracted",
      severity: "info",
      questionKey: null,
      detail: "The agent's extraction came back empty; the answers were read from the transcript",
    });
  }

  return {
    ...base,
    derivedStatus,
    outcome: pulse.outcome,
    errorMessage,
    extracted: pulse.extracted,
    answers,
    answeredCount: qa.answeredCount,
    callbackTimeText: pulse.callbackTime,
    qaState,
    flags,
    extractionSource,
    extractionMissing,
  };
}
