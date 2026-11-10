import { and, asc, count, eq, isNull, lt, notExists } from "drizzle-orm";
import type { VoiceExecution } from "../../calls/execution";
import { parseExecutionTime, interpretExecution } from "../../calls/ingest/interpret";
import { FINAL_STATUS_RANK, statusRank } from "../../calls/ingest/status";
import { isUuid } from "../../domain/uuid";
import type { SurveyDefinition } from "../../surveys/schema";
import type { Db } from "../client";
import { answerOverrides, callFlags, calls, executionEvents, setRecipients, sets, surveys } from "../schema";
import { previousWeekAnswers } from "./calls";

/**
 * The one way a execution becomes a call in our database (spec §5.3). It is safe to replay: an
 * event older than what we stored, or the same event again, changes nothing.
 *
 * Every event is recorded first (execution_events, with the raw payload), then interpreted and applied
 * in one transaction: the call row and its QA flags. The interpretation itself is pure
 * (src/lib/calls/ingest/), so what a call says is decided in one tested place.
 */

/** The database, or a transaction on it (tests and callers that already hold one). */
export type DbConn = Pick<Db, "select" | "insert" | "update" | "delete" | "transaction">;

export type IngestContext = {
  /** voice agents we own. Executions from any other agent are rejected (spec §8.3). */
  ourAgentIds: ReadonlySet<string>;
  /**
   * Links an execution that doesn't carry our call reference to a recipient. Normally the reference
   * the voice agent echoes back in `recipient_data.nabz_call_ref` does this.
   */
  recipientId?: string;
  /**
   * The fallback's re-extraction of this call's transcript, applied even though the agent's
   * execution itself hasn't changed. Stored, so later replays read the call the same way.
   */
  reextracted?: { data: Record<string, unknown>; at: Date };
  /** The agent version that asked this call (the agent for the dealer's language). */
  agentVersionId?: string;
  /** Re-run the interpretation of an unchanged execution (after an ops correction): no stale check. */
  reapply?: boolean;
};

export type IngestResult = {
  result: "ingested" | "stale" | "unlinked" | "rejected";
  callId: string | null;
  eventId: string;
};

function callRefOf(execution: VoiceExecution): string | null {
  const ref = execution.context_details?.recipient_data?.nabz_call_ref;
  return typeof ref === "string" && isUuid(ref) ? ref : null;
}

export async function ingestExecution(db: DbConn, execution: VoiceExecution, ctx: IngestContext): Promise<IngestResult> {
  const [event] = await db
    .insert(executionEvents)
    .values({
      executionId: typeof execution.id === "string" ? execution.id : null,
      executionStatus: typeof execution.status === "string" ? execution.status : null,
      payload: execution as Record<string, unknown>,
    })
    .returning({ id: executionEvents.id });
  if (!event) throw new Error("Could not record the event");

  try {
    const outcome = await db.transaction((tx) => applyExecution(tx, execution, ctx));
    await db
      .update(executionEvents)
      .set({ processedAt: new Date(), result: outcome.result, callId: outcome.callId })
      .where(eq(executionEvents.id, event.id));
    return { ...outcome, eventId: event.id };
  } catch (error) {
    await db
      .update(executionEvents)
      .set({ processedAt: new Date(), result: "error", error: error instanceof Error ? error.message : String(error) })
      .where(eq(executionEvents.id, event.id));
    throw error;
  }
}

/**
 * Re-reads a stored call from its stored execution, inside the caller's transaction: after ops
 * correct an answer, the answers, flags and QA state are recomputed exactly as ingestion computes
 * them. No event is recorded (nothing came from the voice agent), and the call's own agent is trusted
 * (the call was accepted when it arrived). A decision a person already made stands.
 */
export async function reinterpretCall(tx: DbConn, callId: string): Promise<void> {
  const [row] = await tx.select({ raw: calls.rawExecution }).from(calls).where(eq(calls.id, callId));
  const execution = row?.raw as VoiceExecution | null | undefined;
  if (!execution) throw new Error("This call has no stored execution to re-read.");
  const result = await applyExecution(tx, execution, {
    ourAgentIds: new Set([execution.agent_id]),
    reapply: true,
  });
  if (result.result !== "ingested" || result.callId !== callId) {
    throw new Error(`Re-reading the call failed (${result.result}).`);
  }
}

async function applyExecution(
  tx: DbConn,
  execution: VoiceExecution,
  ctx: IngestContext,
): Promise<Omit<IngestResult, "eventId">> {
  if (typeof execution.id !== "string" || !execution.id || typeof execution.status !== "string") {
    return { result: "rejected", callId: null };
  }
  if (!ctx.ourAgentIds.has(execution.agent_id)) return { result: "rejected", callId: null };

  // Link: the call we already have for this execution, else the recipient we were told, else our
  // call reference echoed back by the voice agent.
  const [existing] = await tx.select().from(calls).where(eq(calls.executionId, execution.id)).limit(1);
  let recipientId = existing?.setRecipientId ?? ctx.recipientId ?? null;
  if (!recipientId) {
    const ref = callRefOf(execution);
    if (ref) {
      const [byRef] = await tx
        .select({ id: setRecipients.id })
        .from(setRecipients)
        .where(eq(setRecipients.callRef, ref))
        .limit(1);
      recipientId = byRef?.id ?? null;
    }
  }
  if (!recipientId) return { result: "unlinked", callId: null };

  const [link] = await tx
    .select({
      recipientId: setRecipients.id,
      dealerId: setRecipients.dealerId,
      setId: sets.id,
      weekStart: sets.weekStart,
      surveyId: sets.surveyId,
      surveySlug: surveys.slug,
      definition: surveys.definition,
    })
    .from(setRecipients)
    .innerJoin(sets, eq(sets.id, setRecipients.setId))
    .innerJoin(surveys, eq(surveys.id, sets.surveyId))
    .where(eq(setRecipients.id, recipientId))
    .limit(1);
  if (!link) return { result: "unlinked", callId: null };
  const definition = link.definition as SurveyDefinition;

  // Never move backwards: an older status, or the same one the voice agent hasn't changed since, is stale.
  if (existing) {
    const rank = statusRank(execution.status);
    const updatedAt = parseExecutionTime(execution.updated_at);
    const older = rank < existing.statusRank;
    const unchanged =
      rank === existing.statusRank &&
      (!updatedAt || (existing.executionUpdatedAt !== null && updatedAt <= existing.executionUpdatedAt));
    // A re-extraction is new information about an unchanged execution: it always applies.
    if (older || (unchanged && !ctx.reextracted && !ctx.reapply)) return { result: "stale", callId: existing.id };
  }

  const overrides: Record<string, string | number | null> = {};
  if (existing) {
    const rows = await tx
      .select({ questionKey: answerOverrides.questionKey, newValue: answerOverrides.newValue })
      .from(answerOverrides)
      .where(eq(answerOverrides.callId, existing.id))
      .orderBy(asc(answerOverrides.createdAt));
    for (const r of rows) overrides[r.questionKey] = r.newValue ?? null; // the latest wins
  }
  const previous = await previousWeekAnswers(tx, {
    dealerId: link.dealerId,
    surveySlug: link.surveySlug,
    weekStart: link.weekStart,
    minAnswered: definition.qa.minAnsweredForUsable,
  });
  const reextracted = ctx.reextracted?.data ?? existing?.reextractedData ?? null;
  const c = interpretExecution(definition, execution, previous, { overrides, reextracted });

  // A person's QA decision stands; the automatic checks are still recomputed and shown.
  const reviewed = Boolean(existing?.qaReviewedAt);
  const values = {
    executionStatus: c.executionStatus,
    statusRank: c.statusRank,
    derivedStatus: c.derivedStatus,
    outcome: c.outcome,
    answeredByVoicemail: c.answeredByVoicemail,
    initiatedAt: c.initiatedAt,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    durationS: c.durationS,
    costCents: c.costCents,
    costBreakdown: c.costBreakdown,
    hangupBy: c.hangupBy,
    hangupReason: c.hangupReason,
    errorMessage: c.errorMessage,
    transcript: c.transcript,
    extracted: c.extracted,
    answers: c.answers,
    answeredCount: c.answeredCount,
    callbackTimeText: c.callbackTimeText,
    extractionSource: c.extractionSource,
    ...(ctx.reextracted ? { reextractedData: ctx.reextracted.data, reextractedAt: ctx.reextracted.at } : {}),
    qaState: reviewed && existing ? existing.qaState : c.qaState,
    rawExecution: execution as Record<string, unknown>,
    executionUpdatedAt: c.executionUpdatedAt,
  };

  let callId: string;
  if (existing) {
    await tx.update(calls).set(values).where(eq(calls.id, existing.id));
    callId = existing.id;
  } else {
    const [{ n: earlier } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(calls)
      .where(eq(calls.setRecipientId, link.recipientId));
    const [inserted] = await tx
      .insert(calls)
      .values({
        ...values,
        executionId: execution.id,
        setRecipientId: link.recipientId,
        dealerId: link.dealerId,
        setId: link.setId,
        surveyId: link.surveyId,
        agentVersionId: ctx.agentVersionId ?? null,
        attempt: earlier + 1,
        weekStart: link.weekStart,
      })
      .returning({ id: calls.id });
    if (!inserted) throw new Error("Insert returned no call");
    callId = inserted.id;
  }

  await tx.delete(callFlags).where(eq(callFlags.callId, callId));
  if (c.flags.length) {
    await tx.insert(callFlags).values(c.flags.map((f) => ({ callId, ...f })));
  }

  if (c.terminal) {
    // The first finished call fixes this survey version: from now on it can't be edited, only replaced.
    await tx
      .update(surveys)
      .set({ frozenAt: new Date() })
      .where(and(eq(surveys.id, link.surveyId), isNull(surveys.frozenAt)));
    // Done when no call is still going and every included recipient has a finished call.
    const [open] = await tx
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.setId, link.setId), lt(calls.statusRank, FINAL_STATUS_RANK)))
      .limit(1);
    const [waiting] = await tx
      .select({ id: setRecipients.id })
      .from(setRecipients)
      .where(
        and(
          eq(setRecipients.setId, link.setId),
          eq(setRecipients.included, true),
          notExists(
            tx
              .select({ id: calls.id })
              .from(calls)
              .where(and(eq(calls.setRecipientId, setRecipients.id), eq(calls.statusRank, FINAL_STATUS_RANK))),
          ),
        ),
      )
      .limit(1);
    if (!open && !waiting) {
      await tx
        .update(sets)
        .set({ status: "completed" })
        .where(and(eq(sets.id, link.setId), eq(sets.status, "running")));
    }
  }

  return { result: "ingested", callId };
}
