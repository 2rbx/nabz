import { type VoiceExecution, TERMINAL_STATUSES } from "../execution";
import type { AnswerStatus, DerivedStatus, Outcome } from "../../domain/constants";
import { surveyOutcome } from "../answer-status";

/**
 * Where a execution is in its life, and what that means for us (spec §5.3). Pure.
 *
 * A call is reported several times as it goes: queued → initiated → ringing → in-progress →
 * call-disconnected → a terminal status. Events can arrive late or twice, so each status has a rank
 * and a stored call never moves back to a lower one. call-disconnected is not final: the terminal
 * status (and the extraction) comes after it.
 */

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

export const FINAL_STATUS_RANK = 10;

const LIFECYCLE_RANK: Record<string, number> = {
  rescheduled: 1,
  queued: 1,
  scheduled: 1,
  initiated: 2,
  ringing: 3,
  "in-progress": 4,
  "call-disconnected": 5,
};

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** Position of a call status in the call's life; unknown statuses rank lowest so they never win. */
export function statusRank(status: string): number {
  if (isTerminal(status)) return FINAL_STATUS_RANK;
  return LIFECYCLE_RANK[status] ?? 0;
}

/**
 * Whether the dealer actually spoke with the agent. The call status says "completed" for any call that ended
 * normally, including one nobody spoke on, so a conversation needs talk time and at least one line
 * from the dealer (spec L208).
 */
export function conversationHappened(execution: Pick<VoiceExecution, "conversation_duration" | "transcript">): boolean {
  const talked = (execution.conversation_duration ?? 0) > 0;
  const dealerSpoke = (execution.transcript ?? "").split("\n").some((line) => /^\s*user\s*:/i.test(line));
  return talked && dealerSpoke;
}

export type StatusInput = {
  /** Status of each index question, in definition order. */
  indexStatuses: readonly AnswerStatus[];
  /** How many index questions have a real answer. */
  answeredIndex: number;
  /** What the outcome extraction said, if it was a known outcome. */
  outcome: Outcome | null;
  /** The survey's `qa.minAnsweredForUsable`. */
  minAnswered: number;
};

/**
 * Our status for the call (spec §5.3 table). For a real conversation the data decides: a call with
 * enough answers is completed or partial whatever the outcome extraction says ("refused" with four
 * answers is a partial call). Without enough answers, the outcome extraction explains the call.
 */
export function deriveStatus(
  execution: Pick<VoiceExecution, "status" | "conversation_duration" | "transcript" | "answered_by_voice_mail">,
  input: StatusInput,
): DerivedStatus {
  switch (execution.status) {
    case "rescheduled":
    case "queued":
    case "scheduled":
    case "initiated":
    case "ringing":
      return "queued";
    case "in-progress":
    case "call-disconnected":
      return "in_progress";
    case "no-answer":
      return "no_answer";
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "canceled":
    case "stopped":
    case "balance-low":
    case "error":
      return "error";
    case "completed":
      break;
    default:
      // An unknown status: treat it as still in progress rather than guess an ending.
      return "in_progress";
  }

  if (execution.answered_by_voice_mail === true) return "voicemail";
  if (!conversationHappened(execution)) return "no_answer";
  if (input.answeredIndex >= input.minAnswered) return surveyOutcome(input.indexStatuses);
  if (input.outcome && input.outcome !== "completed" && input.outcome !== "partial") return input.outcome;
  return surveyOutcome(input.indexStatuses);
}
