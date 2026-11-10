import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/lib/db/client";
import { loadIndexInputs } from "../../src/lib/db/queries/index-data";
import { calls, dealers, setRecipients, sets } from "../../src/lib/db/schema";
import { nationalOf } from "../../src/lib/index/engine";
import { buildPulseView, historyStart } from "../../src/lib/index/view";
import { inRollback, latestSurveyId, testDb } from "./helpers";

const { db, pool } = testDb();
afterAll(() => pool.end());

const NOW = new Date("2026-10-27T12:00:00Z"); // Tuesday of 2026-W44
const WEEK = "2026-10-26";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function view(tx: Tx) {
  const inputs = (await loadIndexInputs(tx as unknown as Db, {
    surveySlug: "vehicle_pulse",
    fromWeek: historyStart(NOW),
  }))!;
  const v = buildPulseView(
    { definition: inputs.survey.definition, calls: inputs.calls, cityOf: inputs.cityOf },
    { now: NOW },
  );
  return v && { definition: inputs.survey.definition, ...v };
}

const heroKa = (v: NonNullable<Awaited<ReturnType<typeof view>>>) => v.index.cuts.brand_state!.find((g) => g.key === "brand=hero;state=KA")!;

/** A Hero dealer in Bengaluru answering this week's call. */
async function heroAnswer(tx: Tx) {
  const surveyId = await latestSurveyId(tx);
  const [dealer] = await tx
    .insert(dealers)
    .values({
      sectorSlug: "vehicles",
      businessName: "Fixture Hero Bengaluru",
      phoneE164: "+919000000001",
      cityCode: "ka-bengaluru",
      attributes: { brand: "hero", segment: "two_wheeler" },
    })
    .returning();
  const [set] = await tx.insert(sets).values({ surveyId, weekStart: WEEK, createdBy: "test" }).returning();
  const [recipient] = await tx
    .insert(setRecipients)
    .values({ setId: set!.id, dealerId: dealer!.id, included: true })
    .returning();
  await tx.insert(calls).values({
    executionId: "exec_fixture_1",
    setRecipientId: recipient!.id,
    dealerId: dealer!.id,
    setId: set!.id,
    surveyId,
    weekStart: WEEK,
    executionStatus: "completed",
    statusRank: 10,
    derivedStatus: "completed",
    initiatedAt: new Date("2026-10-27T07:00:00Z"),
    startedAt: new Date("2026-10-27T07:00:05Z"),
    durationS: 95,
    answers: {
      enquiries_trend: "up",
      bookings_trend: "up",
      bookings_week: 30,
      stock_days: 20,
      discount_trend: "same",
      loan_rejections: "normal",
    },
    answeredCount: 5,
    qaState: "auto_ok",
  });
}

describe("the live index: real calls only", () => {
  it("is empty before any call has been made", async () => {
    await inRollback(db, async (tx) => {
      expect(await view(tx)).toBeNull();
    });
  });

  it("a call counts in its cell and in the national number", async () => {
    await inRollback(db, async (tx) => {
      await heroAnswer(tx);
      const after = (await view(tx))!;
      expect(after.week).toBe(WEEK);
      expect(heroKa(after).n).toBe(1);
      expect(nationalOf(after.definition, after.index)!.n).toBe(1);
      expect(after.coverage.dealers).toBe(1);
    });
  });

  it("leaves out calls held for review", async () => {
    await inRollback(db, async (tx) => {
      await heroAnswer(tx);
      await tx.update(calls).set({ qaState: "needs_review" }).where(eq(calls.executionId, "exec_fixture_1"));
      expect(await view(tx)).toBeNull();
    });
  });
});
