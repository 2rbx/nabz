/**
 * One finished (or in-progress) voice call, as the ingest reads it: its status, transcript, cost and the
 * fields extracted from the conversation. The voice agent builds one of these for every call
 * (`buildExecution`, src/lib/voice/agent.ts). Pure: shared by the app, scripts and tests.
 */

/** Statuses after which an execution won't change any more. */
export const TERMINAL_STATUSES = [
  "completed",
  "no-answer",
  "busy",
  "failed",
  "canceled",
  "stopped",
  "error",
  "balance-low",
] as const;

export type VoiceExecution = {
  id: string;
  agent_id: string;
  status: string;
  termination_reason?: string | null;
  error_message?: string | null;
  conversation_duration?: number | null;
  /** True when the call was picked up by an answering machine. */
  answered_by_voice_mail?: boolean | null;
  /** When the call was placed. UTC, written without an offset. */
  initiated_at?: string | null;
  /** What the call was started with, echoed back in `recipient_data` (how an execution finds its dealer). */
  context_details?: { recipient_data?: Record<string, unknown> | null; [key: string]: unknown } | null;
  /** US cents. */
  total_cost?: number | null;
  transcript?: string | null;
  summary?: string | null;
  extracted_data?: Record<string, Record<string, Record<string, unknown>>> | null;
  cost_breakdown?: Record<string, number> | null;
  telephony_data?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};
