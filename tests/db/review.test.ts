import { count, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { VoiceExecution } from "../../src/lib/calls/execution";
import ta02Reextracted from "../../src/lib/calls/ingest/fixtures/ta02-reextracted.json";
import type { Db } from "../../src/lib/db/client";
import { listCalls, reviewCounts } from "../../src/lib/db/queries/calls";
import { loadIndexInputs } from "../../src/lib/db/queries/index-data";
import { ingestExecution } from "../../src/lib/db/queries/ingest";
import { correctAnswer, reviewCall } from "../../src/lib/db/queries/review";
import { answerOverrides, auditLog, callFlags, calls } from "../../src/lib/db/schema";
import { ctx, execution, setup, type Tx, WEEK } from "./call-fixtures";
import { inRollback, testDb } from "./helpers";

const { db, pool } = testDb();
afterAll(() => pool.end());

const OPS = { actor: "ops" };

/** Ingests a fixture execution (optionally changed) for a new real dealer; returns the stored call. */
async function ingested(tx: Tx, name: string, change: (e: VoiceExecution) => VoiceExecution = (e) => e, phone?: string) {
  const s = await setup(tx, { phone });
  const e = change(execution(name, s.callRef));
  const { callId } = await ingestExecution(tx, e, ctx(e));
  return { s, e, callId: callId! };
}

/** en01 with stock extracted as 900 days: over the maximum, so the call is held (invalid_answer). */
const stockOutOfRange = (e: VoiceExecution): VoiceExecution => {
  const pulse = (e.extracted_data as { Pulse: Record<string, Record<string, unknown>> }).Pulse;
  return { ...e, extracted_data: { Pulse: { ...pulse, stock_days: { ...pulse.stock_days, subjective: "900" } } } };
};

async function callRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(calls).where(eq(calls.id, id));
  return row!;
}

async function flagCodes(tx: Tx, id: string) {
  return (await tx.select({ code: callFlags.code }).from(callFlags).where(eq(callFlags.callId, id))).map((f) => f.code).sort();
}

async function inIndex(tx: Tx, dealerId: string) {
  const inputs = await loadIndexInputs(tx as unknown as Db, { surveySlug: "vehicle_pulse", fromWeek: WEEK });
  return inputs!.calls.some((c) => c.dealerId === dealerId);
}

async function written(tx: Tx) {
  const n = async (t: typeof answerOverrides | typeof auditLog) => (await tx.select({ n: count() }).from(t))[0]!.n;
  return { overrides: await n(answerOverrides), audit: await n(auditLog) };
}

describe("reviewCall", () => {
  it("approving a held call makes it count", async () => {
    await inRollback(db, async (tx) => {
      const { s, callId } = await ingested(tx, "en01-completed", stockOutOfRange);
      expect(await callRow(tx, callId)).toMatchObject({ qaState: "needs_review" });
      expect(await inIndex(tx, s.dealerId)).toBe(false);

      const result = await reviewCall(tx, { callId, decision: "approved", note: "  Stock misheard; rest is fine. ", actor: "ops" });
      expect(result).toEqual({ ok: true, changed: true });
      expect(await callRow(tx, callId)).toMatchObject({
        qaState: "approved",
        qaReviewedBy: "ops",
        qaNote: "Stock misheard; rest is fine.",
      });
      expect(await inIndex(tx, s.dealerId)).toBe(true);

      const [entry] = await tx.select().from(auditLog).where(eq(auditLog.entityId, callId));
      expect(entry).toMatchObject({
        action: "call.review",
        before: { qaState: "needs_review" },
        after: { qaState: "approved" },
        meta: { hasNote: true },
      });
      expect(JSON.stringify(entry)).not.toContain("misheard");
      expect(JSON.stringify(entry)).not.toContain("Fixture Hero");
    });
  });

  it("excluding a call takes it out of the index; the same decision again changes nothing", async () => {
    await inRollback(db, async (tx) => {
      const { s, callId } = await ingested(tx, "en01-completed");
      expect(await inIndex(tx, s.dealerId)).toBe(true);
      expect(await reviewCall(tx, { callId, decision: "excluded", note: "", actor: "ops" })).toEqual({ ok: true, changed: true });
      expect(await callRow(tx, callId)).toMatchObject({ qaState: "excluded", qaNote: null });
      expect(await inIndex(tx, s.dealerId)).toBe(false);

      const before = await written(tx);
      expect(await reviewCall(tx, { callId, decision: "excluded", note: " ", actor: "ops" })).toEqual({ ok: true, changed: false });
      expect(await written(tx)).toEqual(before);
      // Changing the decision is allowed, and audited.
      expect(await reviewCall(tx, { callId, decision: "approved", note: "", actor: "ops" })).toEqual({ ok: true, changed: true });
      expect((await written(tx)).audit).toBe(before.audit + 1);
    });
  });

  it("refuses calls with nothing to review", async () => {
    await inRollback(db, async (tx) => {
      const pending = await ingested(tx, "en01-completed", (e) => ({ ...e, status: "in-progress" }), "+919000000021");
      const missed = await ingested(
        tx,
        "hi04-second-number",
        (e) => ({ ...e, status: "no-answer", conversation_duration: 0, transcript: null }),
        "+919000000022",
      );
      for (const callId of [pending.callId, missed.callId]) {
        expect(await reviewCall(tx, { callId, decision: "approved", note: "", actor: "ops" })).toEqual({
          ok: false,
          error: "Only a finished call where the dealer talked can be reviewed.",
        });
      }
      expect(await reviewCall(tx, { callId: pending.callId, decision: "maybe", note: "", actor: "ops" })).toMatchObject({ ok: false });
      expect(await reviewCall(tx, { callId: "nope", decision: "approved", note: "", actor: "ops" })).toMatchObject({ ok: false });
    });
  });
});

describe("correctAnswer", () => {
  it("fixes ta02's stock (three weeks is 21 days, not 24) and re-checks the call", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("ta02-extraction-missing", s.callRef);
      const { callId } = await ingestExecution(tx, e, {
        ...ctx(e),
        reextracted: { data: ta02Reextracted.extracted_data, at: new Date("2026-10-28T23:35:00Z") },
      });
      expect((await callRow(tx, callId!)).answers.stock_days).toBe(24);

      const result = await correctAnswer(tx, {
        ...OPS,
        callId: callId!,
        questionKey: "stock_days",
        value: "21",
        reason: "Dealer said about three weeks",
      });
      expect(result).toEqual({ ok: true, changed: true });
      const call = await callRow(tx, callId!);
      expect(call).toMatchObject({ qaState: "auto_ok", answeredCount: 5, extractionSource: "reextract" });
      expect(call.answers.stock_days).toBe(21);
      // What the extraction said is kept as it was.
      expect(call.extracted.stock_days).toMatchObject({ value: 24 });

      const [override] = await tx.select().from(answerOverrides).where(eq(answerOverrides.callId, callId!));
      expect(override).toMatchObject({ questionKey: "stock_days", oldValue: 24, newValue: 21, createdBy: "ops" });
      const [entry] = await tx.select().from(auditLog).where(eq(auditLog.action, "call.correct"));
      expect(entry).toMatchObject({ entityId: callId, before: { stock_days: 24 }, after: { stock_days: 21 } });
      expect(JSON.stringify(entry)).not.toContain("three weeks");
    });
  });

  it("fixing the only bad answer releases the hold; a later correction wins", async () => {
    await inRollback(db, async (tx) => {
      const { s, callId } = await ingested(tx, "en01-completed", stockOutOfRange);
      expect(await flagCodes(tx, callId)).toContain("invalid_answer");
      await correctAnswer(tx, { ...OPS, callId, questionKey: "stock_days", value: "15", reason: "Recording says 15" });
      expect(await callRow(tx, callId)).toMatchObject({ qaState: "auto_ok", answeredCount: 5 });
      expect(await flagCodes(tx, callId)).not.toContain("invalid_answer");
      expect(await inIndex(tx, s.dealerId)).toBe(true);

      await correctAnswer(tx, { ...OPS, callId, questionKey: "stock_days", value: "16", reason: "Listened again: 16" });
      expect((await callRow(tx, callId)).answers.stock_days).toBe(16);
    });
  });

  it("'not answered' removes an answer and the call stays completed", async () => {
    await inRollback(db, async (tx) => {
      const { callId } = await ingested(tx, "en01-completed");
      await correctAnswer(tx, { ...OPS, callId, questionKey: "discount_trend", value: "not_answered", reason: "Not actually asked" });
      const call = await callRow(tx, callId);
      expect(call).toMatchObject({ derivedStatus: "completed", answeredCount: 4, qaState: "auto_ok" });
      expect(call.answers).not.toHaveProperty("discount_trend");
    });
  });

  it("keeps a person's approval when an answer is corrected", async () => {
    await inRollback(db, async (tx) => {
      const { callId } = await ingested(tx, "en01-completed", stockOutOfRange);
      await reviewCall(tx, { callId, decision: "approved", note: "", actor: "ops" });
      await correctAnswer(tx, { ...OPS, callId, questionKey: "enquiries_trend", value: "up", reason: "Recording" });
      expect(await callRow(tx, callId)).toMatchObject({ qaState: "approved", answers: { enquiries_trend: "up" } });
    });
  });

  it("refuses bad corrections and writes nothing", async () => {
    await inRollback(db, async (tx) => {
      const { callId } = await ingested(tx, "en01-completed");
      const bare = await ingested(tx, "od01-completed", (e) => e, "+919000000031");
      await tx.update(calls).set({ rawExecution: null }).where(eq(calls.id, bare.callId));
      const before = await written(tx);

      const attempt = (patch: Partial<Parameters<typeof correctAnswer>[1]>) =>
        correctAnswer(tx, { ...OPS, callId, questionKey: "stock_days", value: "21", reason: "why", ...patch });
      expect(await attempt({ value: "400" })).toEqual({ ok: false, error: "Must be between 0 and 365." });
      expect(await attempt({ reason: "  " })).toEqual({ ok: false, error: "Say why the answer is being corrected." });
      expect(await attempt({ value: "15" })).toEqual({ ok: false, error: "That's already the recorded answer." });
      expect(await attempt({ questionKey: "favourite_colour" })).toEqual({ ok: false, error: "Unknown question." });
      expect(await attempt({ callId: bare.callId })).toMatchObject({ ok: false });
      expect(await written(tx)).toEqual(before);
    });
  });
});

describe("listCalls", () => {
  it("filters by review state, and says how many questions were answered", async () => {
    await inRollback(db, async (tx) => {
      const asDb = tx as unknown as Db;
      const before = await reviewCounts(asDb);
      const held = await ingested(tx, "en01-completed", stockOutOfRange, "+919000000041");
      const fine = await ingested(tx, "hi04-owner-stock-unclear", (e) => e, "+919000000042");

      const real = await listCalls(asDb, { page: 1 });
      const ids = real.rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([held.callId, fine.callId]));
      expect(real.rows.find((r) => r.id === fine.callId)).toMatchObject({
        derivedStatus: "completed",
        qaState: "auto_ok",
        answeredCount: 4,
        indexQuestions: 5,
      });

      const review = await listCalls(asDb, { page: 1, qa: "needs_review" });
      expect(review.rows.map((r) => r.id)).toContain(held.callId);
      expect(review.rows.map((r) => r.id)).not.toContain(fine.callId);
      expect(review.rows.every((r) => r.qaState === "needs_review")).toBe(true);
      expect(review.total).toBe(before.needsReview + 1);
      expect(await reviewCounts(asDb)).toEqual({ needsReview: before.needsReview + 1 });

      await reviewCall(tx, { callId: held.callId, decision: "approved", note: "", actor: "ops" });
      const approved = await listCalls(asDb, { page: 1, qa: "approved" });
      expect(approved.rows.map((r) => r.id)).toContain(held.callId);
      expect(await reviewCounts(asDb)).toEqual(before);
    });
  });
});
