import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type AnswerStatus,
  DERIVED_STATUSES,
  type DerivedStatus,
  EXTRACTION_SOURCES,
  type ExtractionSource,
  OUTCOMES,
  type Outcome,
} from "../../domain/constants";
import { SEVERITIES } from "../../surveys/constants";
import { createdAt, inList, isMonday, pk, tstz, updatedAt, weekStart } from "./_shared";
import { agentVersions, sectors, surveys } from "./config";
import { dealers } from "./dealers";

export const SET_STATUSES = ["running", "completed", "stopped"] as const;
export const EXCLUSION_REASONS = ["not_permitted", "no_agent"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * A saved list of dealers that ops can call. A batch that has been called is archived rather than
 * deleted, so its sets stay traceable.
 */
export const batches = pgTable(
  "batches",
  {
    id: pk(),
    sectorSlug: text("sector_slug")
      .notNull()
      .references(() => sectors.slug),
    name: text("name").notNull(),
    notes: text("notes"),
    archivedAt: tstz("archived_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("batches_name_uq")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    check("batches_name_ck", sql`length(trim(${t.name})) between 1 and 60`),
  ],
);

/** Who is in a batch. A dealer is in at most one batch (`batch_members_dealer_uq`). */
export const batchMembers = pgTable(
  "batch_members",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    dealerId: uuid("dealer_id")
      .notNull()
      .references(() => dealers.id),
    addedAt: tstz("added_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "batch_members_pk", columns: [t.batchId, t.dealerId] }),
    unique("batch_members_dealer_uq").on(t.dealerId),
  ],
);

/**
 * A set: one run of a batch, its calls together. Running a batch next week is another set. Its rows are
 * called one at a time. Holds no phone numbers: the recipients are rows in set_recipients.
 */
export const sets = pgTable(
  "sets",
  {
    id: pk(),
    batchId: uuid("batch_id").references(() => batches.id),
    surveyId: uuid("survey_id")
      .notNull()
      .references(() => surveys.id),
    weekStart: weekStart().notNull(),
    status: text("status").$type<(typeof SET_STATUSES)[number]>().notNull().default("running"),
    /** Why a set stopped before its last row (the spend cap, calling switched off, ops pressed Stop). */
    stopReason: text("stop_reason"),
    recipientCount: integer("recipient_count").notNull().default(0),
    estimatedCostCents: numeric("estimated_cost_cents", { precision: 12, scale: 4, mode: "number" })
      .notNull()
      .default(0),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sets_batch_idx").on(t.batchId),
    check("sets_status_ck", inList(t.status, SET_STATUSES)),
    check("sets_week_ck", isMonday(t.weekStart)),
  ],
);

/** Who a set was for, and why anyone was left out. `call_ref` is sent to the voice agent and echoed back. */
export const setRecipients = pgTable(
  "set_recipients",
  {
    id: pk(),
    setId: uuid("set_id")
      .notNull()
      .references(() => sets.id),
    dealerId: uuid("dealer_id")
      .notNull()
      .references(() => dealers.id),
    callRef: uuid("call_ref").notNull().defaultRandom().unique("set_recipients_call_ref_uq"),
    included: boolean("included").notNull(),
    exclusionReason: text("exclusion_reason").$type<ExclusionReason>(),
    /** Why the voice agent wouldn't place this row's call. The set moves on and never redials it. */
    dialError: text("dial_error"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("set_recipients_set_dealer_uq").on(t.setId, t.dealerId),
    check(
      "set_recipients_exclusion_ck",
      sql`(${t.included} = (${t.exclusionReason} is null)) and (${t.exclusionReason} is null or ${inList(t.exclusionReason, EXCLUSION_REASONS)})`,
    ),
  ],
);

export const QA_STATES = ["pending", "auto_ok", "needs_review", "approved", "excluded"] as const;
export type QaState = (typeof QA_STATES)[number];

/** Per extracted field: what the agent returned, the value we parsed, and the agent's confidence/validation. */
export type ExtractedField = {
  raw: unknown;
  value: string | number | null;
  confidence: number | null;
  valid: boolean | null;
  /** Answered, or why not: didn't know, declined, not asked, unclear (src/lib/calls/answer-status.ts). */
  status?: AnswerStatus;
};

/**
 * One row per execution. `answers` holds the effective value of each question after validation
 * and ops overrides; it is the only thing the index engine reads.
 */
export const calls = pgTable(
  "calls",
  {
    id: pk(),
    executionId: text("execution_id").notNull().unique("calls_execution_id_uq"),
    setRecipientId: uuid("set_recipient_id")
      .notNull()
      .references(() => setRecipients.id),
    dealerId: uuid("dealer_id")
      .notNull()
      .references(() => dealers.id),
    setId: uuid("set_id")
      .notNull()
      .references(() => sets.id),
    surveyId: uuid("survey_id")
      .notNull()
      .references(() => surveys.id),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id),
    attempt: integer("attempt").notNull().default(1),
    weekStart: weekStart().notNull(),

    executionStatus: text("execution_status").notNull(),
    /** Position of execution_status in the call lifecycle; updates never move a call backwards. */
    statusRank: smallint("status_rank").notNull(),
    derivedStatus: text("derived_status").$type<DerivedStatus>().notNull(),
    outcome: text("outcome").$type<Outcome>(),
    answeredByVoicemail: boolean("answered_by_voicemail"),

    initiatedAt: tstz("initiated_at").notNull(),
    startedAt: tstz("started_at"),
    endedAt: tstz("ended_at"),
    durationS: numeric("duration_s", { precision: 8, scale: 1, mode: "number" }),
    costCents: numeric("cost_cents", { precision: 12, scale: 4, mode: "number" }),
    costBreakdown: jsonb("cost_breakdown").$type<Record<string, unknown>>(),
    hangupBy: text("hangup_by"),
    hangupReason: text("hangup_reason"),
    errorMessage: text("error_message"),

    transcript: text("transcript"),
    extracted: jsonb("extracted").$type<Record<string, ExtractedField>>().notNull().default({}),
    answers: jsonb("answers").$type<Record<string, string | number>>().notNull().default({}),
    answeredCount: smallint("answered_count").notNull().default(0),
    callbackTimeText: text("callback_time_text"),
    /** Where the answers came from (null when there was no conversation to extract from). */
    extractionSource: text("extraction_source").$type<ExtractionSource>(),
    /**
     * What the fallback re-extraction returned (`extracted_data`), kept so a replay gives the same
     * answers. Only set when the agent's own extraction came back empty.
     */
    reextractedData: jsonb("reextracted_data").$type<Record<string, unknown>>(),
    /** When the fallback ran: set even if it came back empty, so it runs once per call. */
    reextractedAt: tstz("reextracted_at"),

    qaState: text("qa_state").$type<QaState>().notNull().default("pending"),
    qaReviewedAt: tstz("qa_reviewed_at"),
    qaReviewedBy: text("qa_reviewed_by"),
    qaNote: text("qa_note"),

    /** The full execution object from the voice agent, for replays and debugging. */
    rawExecution: jsonb("raw_execution").$type<Record<string, unknown>>(),
    executionUpdatedAt: tstz("execution_updated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("calls_survey_week_idx").on(t.surveyId, t.weekStart),
    index("calls_dealer_week_idx").on(t.dealerId, t.weekStart),
    index("calls_set_idx").on(t.setId),
    index("calls_needs_review_idx")
      .on(t.qaState)
      .where(sql`${t.qaState} = 'needs_review'`),
    index("calls_created_idx").on(t.createdAt),
    check("calls_derived_status_ck", inList(t.derivedStatus, DERIVED_STATUSES)),
    check("calls_outcome_ck", sql`${t.outcome} is null or ${inList(t.outcome, OUTCOMES)}`),
    check("calls_qa_state_ck", inList(t.qaState, QA_STATES)),
    check(
      "calls_extraction_source_ck",
      sql`${t.extractionSource} is null or ${inList(t.extractionSource, EXTRACTION_SOURCES)}`,
    ),
    check("calls_week_ck", isMonday(t.weekStart)),
    check("calls_attempt_ck", sql`${t.attempt} >= 1`),
    check("calls_answered_count_ck", sql`${t.answeredCount} >= 0`),
  ],
);

/** Automatic QA flags. Recomputed from the data whenever a call changes; human decisions live in qa_state. */
export const callFlags = pgTable(
  "call_flags",
  {
    id: pk(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    severity: text("severity").$type<(typeof SEVERITIES)[number]>().notNull(),
    questionKey: text("question_key"),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("call_flags_call_code_q_uq").on(t.callId, t.code, t.questionKey).nullsNotDistinct(),
    check("call_flags_severity_ck", inList(t.severity, SEVERITIES)),
  ],
);

/** Corrections made by ops. Append-only (trigger); the latest override per question wins. */
export const answerOverrides = pgTable(
  "answer_overrides",
  {
    id: pk(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    questionKey: text("question_key").notNull(),
    oldValue: jsonb("old_value").$type<string | number | null>(),
    /** null means "treat as not answered". */
    newValue: jsonb("new_value").$type<string | number | null>(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("answer_overrides_call_q_idx").on(t.callId, t.questionKey, t.createdAt),
    check("answer_overrides_reason_ck", sql`length(trim(${t.reason})) > 0`),
  ],
);

export const EVENT_RESULTS = ["ingested", "stale", "unlinked", "rejected", "error"] as const;

/** Every execution received from the voice agent, kept for audit and replay. */
export const executionEvents = pgTable(
  "execution_events",
  {
    id: pk(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    executionId: text("execution_id"),
    executionStatus: text("execution_status"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    processedAt: tstz("processed_at"),
    result: text("result").$type<(typeof EVENT_RESULTS)[number]>(),
    error: text("error"),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
  },
  (t) => [
    index("execution_events_execution_idx").on(t.executionId),
    index("execution_events_received_idx").on(t.receivedAt.desc()),
    check("execution_events_result_ck", sql`${t.result} is null or ${inList(t.result, EVENT_RESULTS)}`),
  ],
);

export const DIALER_ACTIONS = ["call", "test_call"] as const;

/** Every decision the dialer makes, allowed or refused. Test calls' estimates count toward the spend cap. */
export const dialerLog = pgTable(
  "dialer_log",
  {
    id: pk(),
    at: tstz("at").notNull().defaultNow(),
    action: text("action").$type<(typeof DIALER_ACTIONS)[number]>().notNull(),
    setId: uuid("set_id").references(() => sets.id, { onDelete: "set null" }),
    recipientCount: integer("recipient_count").notNull(),
    allowed: boolean("allowed").notNull(),
    refusalCode: text("refusal_code"),
    refusalDetail: text("refusal_detail"),
    estimatedCostCents: numeric("estimated_cost_cents", { precision: 12, scale: 4, mode: "number" })
      .notNull()
      .default(0),
    httpStatus: integer("http_status"),
    executionRef: text("execution_ref"),
    actor: text("actor").notNull(),
  },
  (t) => [
    index("dialer_log_at_idx").on(t.at.desc()),
    check("dialer_log_action_ck", inList(t.action, DIALER_ACTIONS)),
    check("dialer_log_refusal_ck", sql`${t.allowed} = (${t.refusalCode} is null)`),
  ],
);
