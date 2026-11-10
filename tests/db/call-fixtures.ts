import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceExecution } from "../../src/lib/calls/execution";
import type { Db } from "../../src/lib/db/client";
import type { IngestContext } from "../../src/lib/db/queries/ingest";
import { dealers, setRecipients, sets } from "../../src/lib/db/schema";
import { latestSurveyId } from "./helpers";

/** Real executions from our lab calls (scrubbed) and the rows a call needs, for the ingestion tests. */

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const WEEK = "2026-10-26";
const FIXTURES = join(__dirname, "../../src/lib/calls/ingest/fixtures");

/** A real execution from our lab calls (scrubbed), optionally changed, linked to `callRef`. */
export function execution(name: string, callRef: string | null, patch: Partial<VoiceExecution> = {}): VoiceExecution {
  const e = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as VoiceExecution;
  const recipientData = { ...(e.context_details?.recipient_data ?? {}), ...(callRef ? { nabz_call_ref: callRef } : {}) };
  return { ...e, context_details: { ...(e.context_details ?? {}), recipient_data: recipientData }, ...patch };
}

/** en01 with its Pulse fields replaced (`fields` maps a field name to its objective/subjective). */
export function withPulse(e: VoiceExecution, fields: Record<string, { objective?: string; subjective?: string }> | null) {
  const pulse = fields
    ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { confidence: 0.9, ...v }]))
    : {};
  return { ...e, extracted_data: { Pulse: pulse } };
}

/** `updated_at` moved by `minutes` from the fixture's. */
export function later(e: VoiceExecution, minutes: number): string {
  return new Date(new Date(e.updated_at as string).getTime() + minutes * 60_000).toISOString();
}

export function ctx(e: VoiceExecution, patch: Partial<IngestContext> = {}): IngestContext {
  return { ourAgentIds: new Set([e.agent_id]), ...patch };
}

export type Setup = { dealerId: string; setId: string; recipientId: string; callRef: string; surveyId: string };

/** A dealer, a one-call set for WEEK and its recipient. */
export async function setup(tx: Tx, options: { phone?: string; dealerId?: string; setId?: string } = {}): Promise<Setup> {
  const surveyId = await latestSurveyId(tx);
  let dealerId = options.dealerId;
  if (!dealerId) {
    const [d] = await tx
      .insert(dealers)
      .values({
        sectorSlug: "vehicles",
        businessName: "Fixture Hero Motors",
        phoneE164: options.phone ?? "+919000000001",
        cityCode: "up-gorakhpur",
        attributes: { brand: "hero", segment: "two_wheeler" },
      })
      .returning({ id: dealers.id });
    dealerId = d!.id;
  }
  let setId = options.setId;
  if (!setId) {
    const [r] = await tx
      .insert(sets)
      .values({ surveyId, weekStart: WEEK, createdBy: "test" })
      .returning({ id: sets.id });
    setId = r!.id;
  }
  const [rr] = await tx
    .insert(setRecipients)
    .values({ setId, dealerId, included: true })
    .returning({ id: setRecipients.id, callRef: setRecipients.callRef });
  return { dealerId, setId, recipientId: rr!.id, callRef: rr!.callRef, surveyId };
}

