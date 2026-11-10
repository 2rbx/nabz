import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/lib/db/client";
import { getCallDetail, listCalls } from "../../src/lib/db/queries/calls";
import {
  answerOverrides,
  sets,
  setRecipients,
  callFlags,
  calls,
  dealers,
  surveys,
} from "../../src/lib/db/schema";
import { inRollback, latestSurveyId, testDb } from "./helpers";

const { db, pool } = testDb();
afterAll(() => pool.end());

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A dealer and a set for week `weekStart`. */
async function fixture(tx: Tx, weekStart: string) {
  const survey = { id: await latestSurveyId(tx) };
  const [r] = await tx
    .insert(dealers)
    .values({
      sectorSlug: "vehicles",
      businessName: "Fixture TVS Motors",
      phoneE164: "+919000000077",
      cityCode: "up-gorakhpur",
      attributes: { brand: "tvs", segment: "two_wheeler" },
    })
    .returning();
  const [b] = await tx
    .insert(sets)
    .values({
      surveyId: survey!.id,
      weekStart,
      createdBy: "test",
    })
    .returning();
  const [br] = await tx
    .insert(setRecipients)
    .values({ setId: b!.id, dealerId: r!.id, included: true })
    .returning();
  return { surveyId: survey!.id, dealerId: r!.id, setId: b!.id, recipientId: br!.id };
}

function callRow(f: Awaited<ReturnType<typeof fixture>>, patch: Partial<typeof calls.$inferInsert>) {
  return {
    executionId: `exec_${Math.random().toString(36).slice(2)}`,
    setRecipientId: f.recipientId,
    dealerId: f.dealerId,
    setId: f.setId,
    surveyId: f.surveyId,
    weekStart: "2026-10-26",
    executionStatus: "completed",
    statusRank: 10,
    derivedStatus: "completed" as const,
    initiatedAt: new Date("2026-10-27T05:00:00Z"),
    ...patch,
  };
}

describe("listCalls", () => {
  it("lists calls newest first with dealer, brand and city", async () => {
    await inRollback(db, async (tx) => {
      const f = await fixture(tx, "2026-10-26");
      await tx.insert(calls).values([
        callRow(f, { startedAt: new Date("2026-10-27T06:00:00Z"), durationS: 78, costCents: 8.04 }),
        callRow(f, { startedAt: new Date("2026-10-28T06:00:00Z"), durationS: 12, costCents: 1.2 }),
        // Never connected: ordered by when it was placed.
        callRow(f, {
          derivedStatus: "no_answer",
          executionStatus: "no-answer",
          initiatedAt: new Date("2026-10-29T06:00:00Z"),
        }),
      ]);
      const { rows, total } = await listCalls(tx as unknown as Db, { page: 1 });
      expect(total).toBe(3);
      expect(rows.map((r) => r.durationS)).toEqual([null, 12, 78]);
      expect(rows[2]).toMatchObject({
        businessName: "Fixture TVS Motors",
        city: "Gorakhpur",
        costCents: 8.04,
        attributes: { brand: "tvs" },
      });
    });
  });

  it("paginates", async () => {
    await inRollback(db, async (tx) => {
      const f = await fixture(tx, "2026-10-26");
      await tx
        .insert(calls)
        .values(
          Array.from({ length: 55 }, (_, i) =>
            callRow(f, { startedAt: new Date(Date.UTC(2026, 9, 27, 5, i)), durationS: i }),
          ),
        );
      const first = await listCalls(tx as unknown as Db, { page: 1 });
      const second = await listCalls(tx as unknown as Db, { page: 2 });
      expect(first.rows).toHaveLength(50);
      expect(second.rows).toHaveLength(5);
      expect(second.rows.at(-1)?.durationS).toBe(0);
    });
  });
});

describe("getCallDetail", () => {
  it("assembles the call, flags, corrections, survey and last week's newest usable answers", async () => {
    await inRollback(db, async (tx) => {
      const f = await fixture(tx, "2026-10-19");
      const [v1] = await tx
        .select({ id: surveys.id })
        .from(surveys)
        .where(and(eq(surveys.slug, "vehicle_pulse"), eq(surveys.version, 1)));
      // Previous week, chosen as the index engine chooses: only calls it would use, from any version of
      // the survey, most answers first. The winner was asked under v1; an excluded call with as many
      // answers, a pending one and one below the usable minimum never count.
      const lastWeek = { weekStart: "2026-10-19", qaState: "auto_ok" as const };
      await tx
        .insert(calls)
        .values([
          callRow(f, { ...lastWeek, startedAt: new Date("2026-10-20T05:00:00Z"), answeredCount: 5, answers: { stock_days: 99 } }),
          callRow(f, { ...lastWeek, surveyId: v1!.id, startedAt: new Date("2026-10-21T05:00:00Z"), answeredCount: 2, answers: { stock_days: 30 } }),
          callRow(f, { ...lastWeek, startedAt: new Date("2026-10-22T05:00:00Z"), qaState: "excluded", answeredCount: 5, answers: { stock_days: 77 } }),
          callRow(f, { ...lastWeek, startedAt: new Date("2026-10-22T05:00:00Z"), qaState: "pending", answeredCount: 5, answers: { stock_days: 66 } }),
          callRow(f, { ...lastWeek, startedAt: new Date("2026-10-22T05:00:00Z"), answeredCount: 1, answers: { stock_days: 55 } }),
        ]);
      const [target] = await tx
        .insert(calls)
        .values(
          callRow(f, {
            answeredCount: 5,
            answers: { enquiries_trend: "up", stock_days: 20 },
            extracted: { enquiries_trend: { raw: "up", value: "up", confidence: 0.9, valid: true } },
          }),
        )
        .returning();
      await tx.insert(callFlags).values({ callId: target!.id, code: "contradiction", severity: "warn" });
      await tx.insert(answerOverrides).values({
        callId: target!.id,
        questionKey: "stock_days",
        oldValue: 200,
        newValue: 20,
        reason: "misheard",
        createdBy: "ops",
      });

      const detail = await getCallDetail(tx as unknown as Db, target!.id);
      expect(detail).not.toBeNull();
      expect(detail?.dealer).toMatchObject({ businessName: "Fixture TVS Motors" });
      expect(detail?.city).toBe("Gorakhpur");
      expect(detail?.state).toBe("Uttar Pradesh");
      expect(detail?.definition.slug).toBe("vehicle_pulse");
      expect(detail?.flags).toEqual([
        { code: "contradiction", severity: "warn", questionKey: null, detail: null },
      ]);
      expect(detail?.overrides).toMatchObject([{ questionKey: "stock_days", oldValue: 200, newValue: 20 }]);
      expect(detail?.previousAnswers).toEqual({ stock_days: 30 });
      expect(detail?.extracted.enquiries_trend?.confidence).toBe(0.9);
    });
  });

  it("returns null for unknown or malformed ids", async () => {
    expect(await getCallDetail(db, "00000000-0000-4000-8000-00000000abcd")).toBeNull();
    expect(await getCallDetail(db, "not-a-uuid")).toBeNull();
    expect(await getCallDetail(db, "'; drop table calls; --")).toBeNull();
  });
});
