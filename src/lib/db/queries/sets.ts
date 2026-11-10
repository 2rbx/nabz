import { and, asc, count, countDistinct, desc, eq, gte, inArray, sum } from "drizzle-orm";
import { EXCLUSION_LABEL, type ExclusionCode } from "../../calls/set-status";
import { FINAL_STATUS_RANK } from "../../calls/ingest/status";
import { statusLabel, type Tone } from "../../calls/report";
import { isUuid } from "../../domain/uuid";
import { getCity } from "../../reference/geo";
import { languageName } from "../../reference/languages";
import type { SurveyDefinition } from "../../surveys/schema";
import type { Db } from "../client";
import { batches, calls, dealers, setRecipients, sets, surveys } from "../schema";

/**
 * Sets: each run of a batch, with its calls together. A batch can have many sets (running it next
 * week is another set).
 */

export const SETS_PAGE_SIZE = 50;

async function answerThresholds(db: Pick<Db, "select">) {
  const versions = await db.select({ id: surveys.id, definition: surveys.definition }).from(surveys);
  return new Map(versions.map((v) => [v.id, (v.definition as SurveyDefinition).qa.minAnsweredForUsable]));
}

export async function listSets(db: Db, options: { page: number }) {
  const rows = await db
    .select({
      id: sets.id,
      status: sets.status,
      weekStart: sets.weekStart,
      at: sets.createdAt,
      surveyId: sets.surveyId,
      batchName: batches.name,
    })
    .from(sets)
    .leftJoin(batches, eq(batches.id, sets.batchId))
    .orderBy(desc(sets.createdAt), desc(sets.id))
    .limit(SETS_PAGE_SIZE)
    .offset((options.page - 1) * SETS_PAGE_SIZE);
  const [total] = await db.select({ n: count() }).from(sets);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { rows: [], total: total?.n ?? 0 };

  const recipients = await db
    .select({ setId: setRecipients.setId, n: count() })
    .from(setRecipients)
    .where(and(inArray(setRecipients.setId, ids), eq(setRecipients.included, true)))
    .groupBy(setRecipients.setId);
  const done = await db
    .select({ setId: calls.setId, n: countDistinct(calls.dealerId), cost: sum(calls.costCents) })
    .from(calls)
    .where(and(inArray(calls.setId, ids), eq(calls.statusRank, FINAL_STATUS_RANK)))
    .groupBy(calls.setId);
  const thresholds = await answerThresholds(db);
  const answered = await db
    .select({ setId: calls.setId, surveyId: calls.surveyId, n: countDistinct(calls.dealerId) })
    .from(calls)
    .where(and(inArray(calls.setId, ids), gte(calls.answeredCount, Math.min(...thresholds.values()))))
    .groupBy(calls.setId, calls.surveyId);

  return {
    rows: rows.map((r) => {
      const d = done.find((x) => x.setId === r.id);
      return {
        ...r,
        total: recipients.find((x) => x.setId === r.id)?.n ?? 0,
        done: d?.n ?? 0,
        costCents: Number(d?.cost ?? 0),
        answered: answered.find((x) => x.setId === r.id)?.n ?? 0,
      };
    }),
    total: total?.n ?? 0,
  };
}

export type SetRowState = "waiting" | "calling" | "done" | "skipped" | "failed" | "not_called";

export type SetRow = {
  recipientId: string;
  name: string;
  city: string;
  language: string;
  state: SetRowState;
  label: string;
  tone: Tone;
  callId: string | null;
};

/** One set, row by row, in batch order: what each row is doing now. Null if there's no such set. */
export async function setDetail(db: Db, id: string) {
  if (!isUuid(id)) return null;
  const [set] = await db
    .select({
      id: sets.id,
      status: sets.status,
      stopReason: sets.stopReason,
      weekStart: sets.weekStart,
      at: sets.createdAt,
      batchName: batches.name,
    })
    .from(sets)
    .leftJoin(batches, eq(batches.id, sets.batchId))
    .where(eq(sets.id, id));
  if (!set) return null;

  const recipients = await db
    .select({
      id: setRecipients.id,
      included: setRecipients.included,
      reason: setRecipients.exclusionReason,
      dialError: setRecipients.dialError,
      name: dealers.businessName,
      cityCode: dealers.cityCode,
      language: dealers.language,
    })
    .from(setRecipients)
    .innerJoin(dealers, eq(dealers.id, setRecipients.dealerId))
    .where(eq(setRecipients.setId, id))
    .orderBy(asc(dealers.businessName), asc(dealers.id));
  const setCalls = await db
    .select({
      id: calls.id,
      recipientId: calls.setRecipientId,
      statusRank: calls.statusRank,
      derivedStatus: calls.derivedStatus,
      attempt: calls.attempt,
      costCents: calls.costCents,
    })
    .from(calls)
    .where(eq(calls.setId, id))
    .orderBy(asc(calls.attempt));

  const running = set.status === "running";
  const rows = recipients.map((r): SetRow => {
    const base = {
      recipientId: r.id,
      name: r.name,
      city: getCity(r.cityCode).name,
      language: languageName(r.language),
    };
    const call = setCalls.filter((c) => c.recipientId === r.id).at(-1);
    if (!r.included) {
      const label = EXCLUSION_LABEL[r.reason as ExclusionCode] ?? "Skipped";
      return { ...base, state: "skipped", label: `Skipped: ${label.toLowerCase()}`, tone: "neutral", callId: null };
    }
    if (call && call.statusRank < FINAL_STATUS_RANK) {
      return { ...base, state: "calling", label: "Calling…", tone: "accent", callId: call.id };
    }
    if (call) {
      const status = statusLabel(call.derivedStatus);
      return { ...base, state: "done", label: status.label, tone: status.tone, callId: call.id };
    }
    if (r.dialError) return { ...base, state: "failed", label: "Couldn't call", tone: "bad", callId: null };
    return running
      ? { ...base, state: "waiting", label: "Waiting", tone: "neutral", callId: null }
      : { ...base, state: "not_called", label: "Not called", tone: "neutral", callId: null };
  });

  return {
    set,
    rows,
    counted: rows.filter((r) => r.state !== "skipped").length,
    finished: rows.filter((r) => r.state === "done" || r.state === "failed").length,
    costCents: setCalls.reduce((n, c) => n + (c.costCents ?? 0), 0),
  };
}

export type SetDetail = NonNullable<Awaited<ReturnType<typeof setDetail>>>;
