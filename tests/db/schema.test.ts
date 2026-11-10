import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/lib/db/client";
import { answerOverrides, auditLog, calls, dealers, setRecipients, sets, surveys } from "../../src/lib/db/schema";
import { syncReferenceData } from "../../src/lib/db/sync";
import { expectFailure, inRollback, latestSurveyId, testDb } from "./helpers";

const { db, pool } = testDb();
afterAll(() => pool.end());

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const MONDAY = "2026-10-26";

function dealer(phone: string) {
  return {
    sectorSlug: "vehicles",
    businessName: "Fixture TVS",
    phoneE164: phone,
    cityCode: "up-lucknow",
    attributes: { brand: "tvs", segment: "two_wheeler" },
  };
}

/** A dealer, set, recipient and call, wired together. */
async function wiredCall(tx: Tx) {
  const surveyId = await latestSurveyId(tx);
  const [d] = await tx.insert(dealers).values(dealer("+919876500100")).returning();
  const [set] = await tx.insert(sets).values({ surveyId, weekStart: MONDAY, createdBy: "test" }).returning();
  const [recipient] = await tx
    .insert(setRecipients)
    .values({ setId: set!.id, dealerId: d!.id, included: true })
    .returning();
  const [call] = await tx
    .insert(calls)
    .values({
      executionId: "exec_schema_1",
      setRecipientId: recipient!.id,
      dealerId: d!.id,
      setId: set!.id,
      surveyId,
      weekStart: MONDAY,
      executionStatus: "completed",
      statusRank: 10,
      derivedStatus: "completed",
      initiatedAt: new Date("2026-10-27T06:00:00Z"),
    })
    .returning();
  return { set: set!, call: call! };
}

describe("constraints", () => {
  it("lets several dealers share a phone", async () => {
    await inRollback(db, async (tx) => {
      await tx.insert(dealers).values(dealer("+919876500001"));
      await tx.insert(dealers).values(dealer("+919876500001"));
      const rows = await tx.select().from(dealers).where(eq(dealers.phoneE164, "+919876500001"));
      expect(rows).toHaveLength(2);
    });
  });

  it("only accepts Mondays as survey weeks", async () => {
    await inRollback(db, async (tx) => {
      const surveyId = await latestSurveyId(tx);
      const e = await expectFailure(tx, (sp) =>
        sp.insert(sets).values({ surveyId, weekStart: "2026-10-27", createdBy: "t" }),
      );
      expect(e.constraint).toBe("sets_week_ck");
    });
  });

  it("requires an exclusion reason exactly when a recipient is left out", async () => {
    await inRollback(db, async (tx) => {
      const { set } = await wiredCall(tx);
      const [other] = await tx.insert(dealers).values(dealer("+919876500099")).returning();
      const e = await expectFailure(tx, (sp) =>
        sp.insert(setRecipients).values({
          setId: set.id,
          dealerId: other!.id,
          included: true,
          exclusionReason: "no_agent",
        }),
      );
      expect(e.constraint).toBe("set_recipients_exclusion_ck");
    });
  });
});

describe("guards (0001_guards triggers)", () => {
  it("freezes survey definitions on first use", async () => {
    await inRollback(db, async (tx) => {
      const sid = await latestSurveyId(tx);
      await tx.update(surveys).set({ frozenAt: new Date() }).where(eq(surveys.id, sid));
      const edit = await expectFailure(tx, (sp) => sp.update(surveys).set({ title: "Changed" }).where(eq(surveys.id, sid)));
      expect(edit.code).toBe("NZ001");
      expect(edit.message).toMatch(/frozen/);
      const del = await expectFailure(tx, (sp) => sp.delete(surveys).where(eq(surveys.id, sid)));
      expect(del.code).toBe("NZ001");
      // Retiring a frozen version is allowed.
      await tx.update(surveys).set({ status: "retired" }).where(eq(surveys.id, sid));
    });
  });

  it("keeps the audit log and answer corrections append-only", async () => {
    await inRollback(db, async (tx) => {
      const [a] = await tx.insert(auditLog).values({ actor: "test", action: "set.start", entityType: "set" }).returning();
      const upd = await expectFailure(tx, (sp) => sp.update(auditLog).set({ actor: "x" }).where(eq(auditLog.id, a!.id)));
      expect(upd.code).toBe("NZ001");
      const del = await expectFailure(tx, (sp) => sp.delete(auditLog).where(eq(auditLog.id, a!.id)));
      expect(del.code).toBe("NZ001");
      const trunc = await expectFailure(tx, (sp) => sp.execute(sql`truncate audit_log`));
      expect(trunc.code).toBe("NZ001");

      const { call } = await wiredCall(tx);
      const [o] = await tx
        .insert(answerOverrides)
        .values({ callId: call.id, questionKey: "stock_days", newValue: 60, reason: "misheard", createdBy: "t" })
        .returning();
      const edit = await expectFailure(tx, (sp) =>
        sp.update(answerOverrides).set({ reason: "x" }).where(eq(answerOverrides.id, o!.id)),
      );
      expect(edit.code).toBe("NZ001");
    });
  });
});

describe("sync", () => {
  it("is idempotent and refuses to change a frozen definition", async () => {
    await inRollback(db, async (tx) => {
      const asDb = tx as unknown as Db;
      expect((await syncReferenceData(asDb)).surveys).toEqual([
        "vehicle_pulse v1: unchanged",
        "vehicle_pulse v2: unchanged",
      ]);
      // Simulate code drifting from a frozen version: change v2's stored hash, then freeze it.
      const v2 = and(eq(surveys.slug, "vehicle_pulse"), eq(surveys.version, 2));
      await tx.update(surveys).set({ definitionSha256: "b".repeat(64) }).where(v2);
      await tx.update(surveys).set({ frozenAt: new Date() }).where(v2);
      await expect(syncReferenceData(asDb)).rejects.toThrow(/frozen .* add version 3/);
    });
  });
});
