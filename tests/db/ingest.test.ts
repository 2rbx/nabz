import { count, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/lib/db/client";
import { loadIndexInputs } from "../../src/lib/db/queries/index-data";
import { ingestExecution } from "../../src/lib/db/queries/ingest";
import { answerOverrides, callFlags, calls, dealers, executionEvents, sets, surveys } from "../../src/lib/db/schema";
import { ctx, execution, later, setup, type Tx, WEEK, withPulse } from "./call-fixtures";
import { inRollback, testDb } from "./helpers";

const { db, pool } = testDb();
afterAll(() => pool.end());

async function callOf(tx: Tx, executionId: string) {
  const [row] = await tx.select().from(calls).where(eq(calls.executionId, executionId));
  return row;
}

async function counts(tx: Tx) {
  const n = async (table: typeof calls | typeof callFlags) => (await tx.select({ n: count() }).from(table))[0]!.n;
  return { calls: await n(calls), flags: await n(callFlags) };
}

async function eventResults(tx: Tx, executionId: string) {
  const rows = await tx
    .select({ result: executionEvents.result, processedAt: executionEvents.processedAt, at: executionEvents.receivedAt })
    .from(executionEvents)
    .where(eq(executionEvents.executionId, executionId));
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime()).map((r) => r.result);
}

describe("ingestExecution: a real completed call", () => {
  it("stores the call as interpreted, linked through our call reference", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      const out = await ingestExecution(tx, e, ctx(e));
      expect(out.result).toBe("ingested");

      const row = await callOf(tx, e.id);
      expect(row).toMatchObject({
        id: out.callId,
        dealerId: s.dealerId,
        setId: s.setId,
        setRecipientId: s.recipientId,
        surveyId: s.surveyId,
        weekStart: WEEK,
        attempt: 1,
        executionStatus: "completed",
        statusRank: 10,
        derivedStatus: "completed",
        qaState: "auto_ok",
        answeredCount: 5,
        answers: {
          enquiries_trend: "same",
          bookings_trend: "same",
          bookings_week: 20,
          stock_days: 15,
          discount_trend: "down",
          loan_rejections: "low",
        },
      });
      expect(row!.rawExecution).toMatchObject({ id: e.id });
      expect(row!.executionUpdatedAt?.toISOString()).toBe(new Date(e.updated_at as string).toISOString());
    });
  });

  it("counts in the index", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      await ingestExecution(tx, e, ctx(e));
      const inputs = await loadIndexInputs(tx as unknown as Db, {
        surveySlug: "vehicle_pulse",
        fromWeek: WEEK,
      });
      const mine = inputs!.calls.filter((c) => c.dealerId === s.dealerId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ weekStart: WEEK, qaState: "auto_ok", answers: { bookings_week: 20 } });
    });
  });

  it("freezes the survey version on the first finished call", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      await tx.update(surveys).set({ frozenAt: null }).where(eq(surveys.id, s.surveyId));
      const e = execution("en01-completed", s.callRef);
      await ingestExecution(tx, e, ctx(e));
      const [survey] = await tx.select({ frozenAt: surveys.frozenAt }).from(surveys).where(eq(surveys.id, s.surveyId));
      expect(survey!.frozenAt).not.toBeNull();
    });
  });

  it("completes a one-call set once its call has finished", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      await ingestExecution(tx, { ...e, status: "in-progress", updated_at: later(e, -2) }, ctx(e));
      const [running] = await tx.select({ status: sets.status }).from(sets).where(eq(sets.id, s.setId));
      expect(running!.status).toBe("running");
      await ingestExecution(tx, e, ctx(e));
      const [done] = await tx.select({ status: sets.status }).from(sets).where(eq(sets.id, s.setId));
      expect(done!.status).toBe("completed");
    });
  });

  it("keeps a set open while another recipient has no finished call", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      await setup(tx, { setId: s.setId, phone: "+919000000002" });
      const e = execution("en01-completed", s.callRef);
      await ingestExecution(tx, e, ctx(e));
      const [set] = await tx.select({ status: sets.status }).from(sets).where(eq(sets.id, s.setId));
      expect(set!.status).toBe("running");
    });
  });
});

describe("ingestExecution: replays and order", () => {
  it("replaying the same execution changes nothing", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("hi04-owner-stock-unclear", s.callRef);
      const first = await ingestExecution(tx, e, ctx(e));
      const before = { counts: await counts(tx), row: await callOf(tx, e.id) };
      const again = await ingestExecution(tx, e, ctx(e));
      expect(again).toMatchObject({ result: "stale", callId: first.callId });
      expect(await counts(tx)).toEqual(before.counts);
      expect(await callOf(tx, e.id)).toEqual(before.row);
      expect(await eventResults(tx, e.id)).toEqual(["ingested", "stale"]);
    });
  });

  it("ignores an older status that arrives after a newer one", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      await ingestExecution(tx, e, ctx(e));
      const late = await ingestExecution(tx, { ...e, status: "ringing", updated_at: later(e, 5) }, ctx(e));
      expect(late.result).toBe("stale");
      expect(await callOf(tx, e.id)).toMatchObject({ executionStatus: "completed", answeredCount: 5 });
    });
  });

  it("moves through the lifecycle: call-disconnected is not final, completed is", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      await ingestExecution(tx, { ...e, status: "in-progress", updated_at: later(e, -3) }, ctx(e));
      expect(await callOf(tx, e.id)).toMatchObject({ derivedStatus: "in_progress", qaState: "pending", answers: {} });
      await ingestExecution(tx, { ...e, status: "call-disconnected", updated_at: later(e, -1) }, ctx(e));
      expect(await callOf(tx, e.id)).toMatchObject({ statusRank: 5, derivedStatus: "in_progress", qaState: "pending" });
      await ingestExecution(tx, e, ctx(e));
      expect(await callOf(tx, e.id)).toMatchObject({ statusRank: 10, derivedStatus: "completed", qaState: "auto_ok" });
      expect(await eventResults(tx, e.id)).toEqual(["ingested", "ingested", "ingested"]);
      const rows = await tx.select({ n: count() }).from(calls).where(eq(calls.setRecipientId, s.recipientId));
      expect(rows[0]!.n).toBe(1);
    });
  });

  it("applies a late extraction (same final status, newer update)", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      await ingestExecution(tx, { ...withPulse(e, null), updated_at: later(e, -1) }, ctx(e));
      const held = await callOf(tx, e.id);
      expect(held).toMatchObject({ qaState: "needs_review", answeredCount: 0, answers: {} });
      const heldFlags = await tx.select({ code: callFlags.code }).from(callFlags).where(eq(callFlags.callId, held!.id));
      expect(heldFlags.map((f) => f.code)).toContain("extraction_missing");

      await ingestExecution(tx, e, ctx(e));
      const fixed = await callOf(tx, e.id);
      expect(fixed).toMatchObject({ qaState: "auto_ok", answeredCount: 5 });
      const flags = await tx.select({ code: callFlags.code }).from(callFlags).where(eq(callFlags.callId, held!.id));
      expect(flags.map((f) => f.code)).not.toContain("extraction_missing");
    });
  });
});

describe("ingestExecution: people's decisions stand", () => {
  it("keeps an approved review when the call is re-ingested", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("ta02-extraction-missing", s.callRef);
      await ingestExecution(tx, e, ctx(e));
      const row = await callOf(tx, e.id);
      expect(row).toMatchObject({ derivedStatus: "partial", qaState: "needs_review" });
      await tx
        .update(calls)
        .set({ qaState: "approved", qaReviewedAt: new Date(), qaReviewedBy: "ops" })
        .where(eq(calls.id, row!.id));
      await ingestExecution(tx, { ...e, updated_at: later(e, 1) }, ctx(e));
      expect(await callOf(tx, e.id)).toMatchObject({ qaState: "approved", qaReviewedBy: "ops" });
    });
  });

  it("puts ops' corrections on top of the extraction (the latest per question)", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("od01-completed", s.callRef);
      const { callId } = await ingestExecution(tx, e, ctx(e));
      expect((await callOf(tx, e.id))!.answers).toMatchObject({ loan_rejections: "high", bookings_week: 2000 });
      const base = { callId: callId!, reason: "listened to the recording", createdBy: "ops" };
      await tx.insert(answerOverrides).values({
        ...base,
        questionKey: "loan_rejections",
        oldValue: "high",
        newValue: "low",
        createdAt: new Date("2026-10-29T18:00:00Z"),
      });
      await tx.insert(answerOverrides).values({
        ...base,
        questionKey: "loan_rejections",
        oldValue: "low",
        newValue: "normal",
        createdAt: new Date("2026-10-29T18:05:00Z"),
      });
      await tx.insert(answerOverrides).values({
        ...base,
        questionKey: "stock_days",
        oldValue: 10,
        newValue: null,
        createdAt: new Date("2026-10-29T18:06:00Z"),
      });
      await ingestExecution(tx, { ...e, updated_at: later(e, 1) }, ctx(e));
      const row = await callOf(tx, e.id);
      expect(row!.answers.loan_rejections).toBe("normal");
      expect(row!.answers).not.toHaveProperty("stock_days");
      // A removed answer is unclear, a response: the call stays completed, with one answer fewer.
      expect(row).toMatchObject({ derivedStatus: "completed", answeredCount: 4 });
      // What the agent returned is kept as it was.
      expect(row!.extracted.stock_days).toMatchObject({ value: 10, status: "answered" });
    });
  });
});

describe("ingestExecution: a call changes nothing on the dealer", () => {
  const dealerRow = async (tx: Tx, id: string) => (await tx.select().from(dealers).where(eq(dealers.id, id)))[0];

  it("an agent's opted_out reads as refused, and the answers still count", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const before = await dealerRow(tx, s.dealerId);
      const full = execution("en01-completed", s.callRef);
      const e = {
        ...full,
        extracted_data: {
          Pulse: {
            ...(full.extracted_data as { Pulse: Record<string, unknown> }).Pulse,
            outcome: { objective: "opted_out", confidence: 0.9 },
          },
        },
      };
      await ingestExecution(tx, e, ctx(e));
      expect(await callOf(tx, e.id)).toMatchObject({ outcome: "refused", derivedStatus: "completed", answeredCount: 5 });
      expect(await dealerRow(tx, s.dealerId)).toEqual(before);
    });
  });

  it("a wrong number is what the call says, not a change to the dealer", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const before = await dealerRow(tx, s.dealerId);
      const e = withPulse(execution("en01-completed", s.callRef), { outcome: { objective: "wrong_number" } });
      await ingestExecution(tx, e, ctx(e));
      expect(await callOf(tx, e.id)).toMatchObject({ derivedStatus: "wrong_number", answeredCount: 0 });
      expect(await dealerRow(tx, s.dealerId)).toEqual(before);
    });
  });
});

describe("ingestExecution: linking and refusing", () => {
  it("links a call without our reference through the recipient it is imported for", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("hi04-second-number", null);
      const out = await ingestExecution(tx, e, ctx(e, { recipientId: s.recipientId }));
      expect(out.result).toBe("ingested");
      expect(await callOf(tx, e.id)).toMatchObject({ setRecipientId: s.recipientId, costCents: 18 });
      // Later events for the same execution find the call by its id, with no hint.
      const next = await ingestExecution(tx, { ...e, updated_at: later(e, 1) }, ctx(e));
      expect(next).toMatchObject({ result: "ingested", callId: out.callId });
    });
  });

  it("numbers a second attempt for the same recipient", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const first = execution("en01-completed", s.callRef, { status: "no-answer" });
      await ingestExecution(tx, first, ctx(first));
      const second = execution("hi04-second-number", s.callRef);
      await ingestExecution(tx, second, ctx(second));
      expect((await callOf(tx, first.id))!.attempt).toBe(1);
      expect((await callOf(tx, second.id))!.attempt).toBe(2);
    });
  });

  it("leaves an execution it can't link unlinked", async () => {
    await inRollback(db, async (tx) => {
      const e = execution("en01-completed", "00000000-0000-4000-8000-000000000000");
      const out = await ingestExecution(tx, e, ctx(e));
      expect(out).toMatchObject({ result: "unlinked", callId: null });
      expect(await callOf(tx, e.id)).toBeUndefined();
      expect(await eventResults(tx, e.id)).toEqual(["unlinked"]);
    });
  });

  it("rejects another agent's execution and touches nothing", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      const out = await ingestExecution(tx, e, ctx(e, { ourAgentIds: new Set(["someone-else"]) }));
      expect(out.result).toBe("rejected");
      expect(await callOf(tx, e.id)).toBeUndefined();
      const [event] = await tx.select().from(executionEvents).where(eq(executionEvents.id, out.eventId));
      expect(event).toMatchObject({ result: "rejected", executionStatus: "completed" });
      expect(event!.processedAt).not.toBeNull();
    });
  });

  it("records a failure on the event and rethrows, leaving no call behind", async () => {
    await inRollback(db, async (tx) => {
      const s = await setup(tx);
      const e = execution("en01-completed", s.callRef);
      // An agent version that doesn't exist fails the insert (its foreign key).
      const broken = ctx(e, { agentVersionId: "00000000-0000-4000-8000-000000000000" });
      await expect(ingestExecution(tx, e, broken)).rejects.toThrow();
      expect(await callOf(tx, e.id)).toBeUndefined();
      const [event] = await tx.select().from(executionEvents).where(eq(executionEvents.executionId, e.id));
      expect(event!.result).toBe("error");
      expect(event!.error).toBeTruthy();
    });
  });
});
