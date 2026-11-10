/**
 * Fills the demo database with synthetic calls made by the real voice stack, through the normal ingest.
 *
 * For each synthetic dealer and week: a Claude-played dealer with known ground truth speaks (Timbre
 * voices the line, optional line noise is added, Prisma transcribes it), the Nabz agent (Claude +
 * Timbre) asks the six questions, and the finished call is read and stored exactly like any real call.
 * Afterwards the extracted answers are compared with the truth the dealer was given.
 *
 * Everything is made up: the dealers have deliberately invalid phone numbers and are marked in their notes.
 * Resumable: dealers, batches, sets and finished calls are never duplicated. Both spend caps apply.
 *
 *   pnpm voice:seed [--limit 10] [--concurrency 3] [--noise 0.03] [--no-agent-speech] [--setup-only]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { saveBatch } from "../../src/lib/db/queries/batches";
import { ingestExecution } from "../../src/lib/db/queries/ingest";
import { createDb } from "../../src/lib/db/client";
import { agentVersions, batches, calls, dealers, setRecipients, sets, surveys } from "../../src/lib/db/schema";
import { addWeeks, weekStartOf } from "../../src/lib/domain/week";
import { env } from "../../src/lib/env";
import { CITIES, getState } from "../../src/lib/reference/geo";
import { BRANDS } from "../../src/lib/sectors/vehicles";
import type { SurveyDefinition } from "../../src/lib/surveys/schema";
import {
  agentSystemPrompt,
  buildExecution,
  extractionPrompt,
  extractionSchema,
  GNANI_LANGUAGE,
  openingLine,
  readReply,
  toMessages,
  type Turn,
} from "../../src/lib/voice/agent";
import { BudgetExceeded } from "../../src/lib/voice/budget";
import { addNoise, dealerFacts, dealerPersonaPrompt, rng, type DealerFacts } from "../../src/lib/voice/persona";
import { speak, voiceFromEnv, type Voice } from "../../src/lib/voice/runtime";
import { loadLocalEnv, runScript } from "../db/_env";

const AGENT_ID = "nabz-gnani-voice-agent";
const SYNTHETIC_NOTE = "Synthetic demo dealer (Gnani challenge). Made-up details and an invalid number.";
const DEALERS_PER_CELL = 5;
const MAX_DEALER_TURNS = 10;

/** Brand × state cells and how strong each market is (-1 weak … +1 strong), so the heatmap has a spread. */
const CELLS: { brand: string; state: string; tilt: number }[] = [
  { brand: "hero", state: "UP", tilt: 0.8 },
  { brand: "hero", state: "BR", tilt: 0.55 },
  { brand: "hero", state: "RJ", tilt: -0.6 },
  { brand: "tvs", state: "TN", tilt: 0.25 },
  { brand: "bajaj", state: "MH", tilt: -0.05 },
  { brand: "honda", state: "UP", tilt: 0.5 },
  { brand: "maruti", state: "MH", tilt: 0.35 },
  { brand: "maruti", state: "KA", tilt: -0.55 },
];

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

type Plan = {
  recipientId: string;
  callRef: string;
  dealerId: string;
  dealerKey: string;
  businessName: string;
  city: string;
  tilt: number;
  week: string;
  facts: DealerFacts;
};

async function setup(db: ReturnType<typeof createDb>["db"]): Promise<{ plans: Plan[]; survey: SurveyDefinition; surveyId: string; agentVersionId: string }> {
  const [surveyRow] = await db.select().from(surveys).where(and(eq(surveys.slug, "vehicle_pulse"), eq(surveys.version, 2)));
  if (!surveyRow) throw new Error("Survey vehicle_pulse v2 isn't synced. Run pnpm db:setup.");
  const survey = surveyRow.definition as SurveyDefinition;

  let [agent] = await db.select().from(agentVersions).where(and(eq(agentVersions.agentRef, AGENT_ID), eq(agentVersions.surveyId, surveyRow.id)));
  if (!agent) {
    const config = {
      stack: "Gnani Prisma (speech to text) + Gnani Timbre (text to speech) + Claude (conversation and extraction)",
      sttModel: "prisma-v3.0",
      ttsModel: "timbre-v2.5",
      replyModel: "claude-haiku-5-5",
      extractModel: "claude-sonnet-5-5",
    };
    [agent] = await db
      .insert(agentVersions)
      .values({
        surveyId: surveyRow.id,
        language: "hi",
        label: "gn01",
        agentRef: AGENT_ID,
        version: 1,
        config,
        configSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
        syncedAt: new Date(),
        syncedBy: "seed",
      })
      .returning();
  }

  const thisWeek = weekStartOf(new Date());
  const weeks = [addWeeks(thisWeek, -1), thisWeek];
  const plans: Plan[] = [];
  let phone = 0;

  for (const cell of CELLS) {
    const brand = BRANDS.find((b) => b.code === cell.brand)!;
    const stateName = getState(cell.state).name;
    const cities = CITIES.filter((c) => c.state === cell.state);
    const memberIds: string[] = [];
    const keys = new Map<string, { id: string; name: string; city: string }>();

    for (let n = 1; n <= DEALERS_PER_CELL; n++) {
      phone += 1;
      const city = cities[(n - 1) % cities.length]!;
      const businessName = `Demo ${brand.label} ${city.name} ${n}`;
      let [row] = await db.select().from(dealers).where(and(eq(dealers.businessName, businessName), like(dealers.notes, "Synthetic demo%")));
      if (!row) {
        [row] = await db
          .insert(dealers)
          .values({
            sectorSlug: "vehicles",
            businessName,
            contactName: "Demo Owner",
            contactRole: "owner",
            // 91 followed by zeros: not a number that can exist.
            phoneE164: `+9100000${String(phone).padStart(5, "0")}`,
            cityCode: city.code,
            language: "hi",
            attributes: { brand: brand.code, segment: brand.segment },
            notes: SYNTHETIC_NOTE,
          })
          .returning();
      }
      memberIds.push(row!.id);
      keys.set(row!.id, { id: row!.id, name: businessName, city: city.name });
    }

    const batchName = `${brand.label} · ${stateName}`;
    let [batch] = await db.select().from(batches).where(eq(batches.name, batchName));
    if (!batch) {
      const saved = await saveBatch(db, { name: batchName, notes: "Synthetic demo batch.", memberIds }, { actor: "seed" });
      if (!saved.ok) throw new Error(`Batch ${batchName}: ${JSON.stringify(saved.errors)}`);
      [batch] = await db.select().from(batches).where(eq(batches.id, saved.id));
    }

    for (const week of weeks) {
      let [set] = await db.select().from(sets).where(and(eq(sets.batchId, batch!.id), eq(sets.weekStart, week)));
      if (!set) {
        [set] = await db
          .insert(sets)
          .values({ batchId: batch!.id, surveyId: surveyRow.id, weekStart: week, status: "completed", recipientCount: memberIds.length, createdBy: "seed" })
          .returning();
      }
      for (const dealerId of memberIds) {
        let [recipient] = await db.select().from(setRecipients).where(and(eq(setRecipients.setId, set!.id), eq(setRecipients.dealerId, dealerId)));
        if (!recipient) {
          [recipient] = await db.insert(setRecipients).values({ setId: set!.id, dealerId, included: true }).returning();
        }
        const [done] = await db.select({ id: calls.id }).from(calls).where(eq(calls.setRecipientId, recipient!.id)).limit(1);
        if (done) continue;
        const d = keys.get(dealerId)!;
        plans.push({
          recipientId: recipient!.id,
          callRef: recipient!.callRef,
          dealerId,
          dealerKey: dealerId,
          businessName: d.name,
          city: d.city,
          // This week's market sits a little above last week's, so the index shows movement.
          tilt: Math.max(-1, Math.min(1, cell.tilt + (week === thisWeek ? 0.1 : -0.1))),
          week,
          facts: dealerFacts(dealerId, week, cell.tilt + (week === thisWeek ? 0.1 : -0.1)),
        });
      }
    }
  }
  return { plans, survey, surveyId: surveyRow.id, agentVersionId: agent!.id };
}

type Outcome = { plan: Plan; ok: boolean; matched: number; asked: number; note?: string };

/** One whole call: the dealer persona speaks through Timbre, noise and Prisma; the agent answers. */
async function runCall(
  voice: Voice,
  db: ReturnType<typeof createDb>["db"],
  ctx: { survey: SurveyDefinition; agentVersionId: string; noise: number; agentSpeech: boolean },
  plan: Plan,
): Promise<Outcome> {
  const dealerCtx = { businessName: plan.businessName, brand: "", city: plan.city };
  const codes = GNANI_LANGUAGE.hi;
  const random = rng(`noise|${plan.recipientId}`);
  const turns: Turn[] = [{ role: "agent", text: openingLine("hi", dealerCtx) }];
  const personaSystem = dealerPersonaPrompt(plan.facts, { businessName: plan.businessName, city: plan.city });
  const startedAt = Date.now();
  if (ctx.agentSpeech) await speak(voice, turns[0]!.text, codes.tts);

  for (let i = 0; i < MAX_DEALER_TURNS; i++) {
    // The persona sees the agent's lines as the user and its own earlier lines as the assistant.
    const personaMessages = [
      ...turns.map((t) => ({ role: t.role === "agent" ? ("user" as const) : ("assistant" as const), content: t.text })),
    ];
    const line = await voice.claude.reply(personaSystem, personaMessages);
    // Spoken by Timbre (Hinglish voice), roughed up, then heard by Prisma.
    const spoken = await voice.gnani.tts({ text: line, voice: "Poorvi", language: "hi-en", container: "wav", sampleRate: 16000 });
    const heard = await voice.gnani.stt(
      ctx.noise > 0 ? addNoise(spoken.audio, ctx.noise, random) : spoken.audio,
      "dealer.wav",
      Math.max(1, (spoken.audio.length - 44) / 32000),
      { languageCode: codes.stt },
    );
    turns.push({ role: "dealer", text: heard.transcript || line });

    const reply = readReply(await voice.claude.reply(agentSystemPrompt(ctx.survey, "hi", dealerCtx), toMessages(turns)));
    if (reply.text) {
      turns.push({ role: "agent", text: reply.text });
      if (ctx.agentSpeech) await speak(voice, reply.text, codes.tts);
    }
    if (reply.ended) break;
  }

  const transcript = turns.map((t) => `${t.role === "dealer" ? "user" : "assistant"}: ${t.text}`).join("\n");
  const extraction = (await voice.claude.extract(extractionPrompt(ctx.survey), transcript, extractionSchema(ctx.survey))) as Record<
    string,
    { value: string | number | null; status: string }
  >;

  // Accuracy: for each question the dealer was told a fact about, did the call record the same value?
  let matched = 0;
  let asked = 0;
  for (const [key, truth] of Object.entries(plan.facts)) {
    const got = extraction[key];
    if (truth === null) {
      asked += 1;
      if (got?.status !== "answered") matched += 1;
    } else {
      asked += 1;
      if (got?.status === "answered" && got.value === truth) matched += 1;
    }
  }

  const monday = new Date(`${plan.week}T00:00:00Z`);
  const midweek = new Date(monday.getTime() + 2 * 86_400_000 + 6.5 * 3_600_000);
  const execution = buildExecution({
    def: ctx.survey,
    turns,
    extraction,
    durationS: Math.round((Date.now() - startedAt) / 1000) + 30,
    agentId: AGENT_ID,
    executionId: crypto.randomUUID(),
    now: midweek.getTime() > Date.now() ? new Date() : midweek,
    costCents: 1,
    recipientData: { nabz_call_ref: plan.callRef },
  });
  const result = await ingestExecution(db, execution, { ourAgentIds: new Set([AGENT_ID]), agentVersionId: ctx.agentVersionId });
  return { plan, ok: result.result === "ingested", matched, asked, note: result.result };
}

runScript(async () => {
  loadLocalEnv();
  const voice = voiceFromEnv();
  if (!voice) throw new Error("GNANI_API_KEY and CLAUDE_API_KEY must both be set in .env");
  const { db, pool } = createDb(env().DATABASE_URL, { max: 4 });
  try {
    const { plans, survey, agentVersionId } = await setup(db);
    console.log(`Database ready. ${plans.length} calls still to make.`);
    if (flag("setup-only")) return;

    const limit = Number(arg("limit") ?? plans.length);
    const concurrency = Math.max(1, Number(arg("concurrency") ?? 3));
    const noise = Number(arg("noise") ?? 0.03);
    const todo = plans.slice(0, limit);
    const before = voice.budget.state();
    const outcomes: Outcome[] = [];
    let next = 0;
    let stopped: string | null = null;

    const worker = async () => {
      while (!stopped) {
        const plan = todo[next++];
        if (!plan) return;
        try {
          const o = await runCall(voice, db, { survey, agentVersionId, noise, agentSpeech: !flag("no-agent-speech") }, plan);
          outcomes.push(o);
          const s = voice.budget.state();
          console.log(
            `[${outcomes.length}/${todo.length}] ${plan.businessName} ${plan.week}: ${o.note}, ${o.matched}/${o.asked} match the truth ` +
              `($${s.claudeUsd.toFixed(2)}, ${s.gnaniCredits.toFixed(0)} credits)`,
          );
        } catch (error) {
          if (error instanceof BudgetExceeded) {
            stopped = error.message;
            return;
          }
          console.log(`✖ ${plan.businessName} ${plan.week}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const matched = outcomes.reduce((n, o) => n + o.matched, 0);
    const asked = outcomes.reduce((n, o) => n + o.asked, 0);
    const after = voice.budget.state();
    const report = {
      calls: outcomes.length,
      ingested: outcomes.filter((o) => o.ok).length,
      answersMatchingTruth: matched,
      answersChecked: asked,
      accuracy: asked ? matched / asked : null,
      noiseLevel: noise,
      claudeUsd: after.claudeUsd - before.claudeUsd,
      gnaniCreditsEstimate: after.gnaniCredits - before.gnaniCredits,
      stoppedBecause: stopped,
    };
    mkdirSync(".voice-cache", { recursive: true });
    writeFileSync(".voice-cache/seed-report.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log("\n" + JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
});
