/**
 * A whole synthetic call with the real Claude and typed dealer replies: the agent asks the six questions,
 * the call is read into answers by the same rules real calls get. No speech, so no Gnani credits unless
 * you pass --speak (the agent's lines are then also voiced by Timbre).
 *
 *   pnpm voice:simulate [--speak]
 */
import { interpretExecution } from "../../src/lib/calls/ingest/interpret";
import { vehiclePulseV2 as def } from "../../src/lib/surveys/definitions/vehicle-pulse.v2";
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
import { speak, voiceFromEnv } from "../../src/lib/voice/runtime";
import { loadLocalEnv, runScript } from "../db/_env";

const dealer = { businessName: "Demo Motors", brand: "Hero", city: "Lucknow" };

/** What a made-up dealer says, in order. The last one is only used if the agent is still asking. */
const DEALER_LINES = [
  "haan ji boliye, main owner bol raha hoon",
  "enquiries thodi badhi hain pichhle hafte se",
  "bookings utni hi hain, lagbhag 25 ho gayi is hafte",
  "stock to abhi dedh mahine ka chalega",
  "discount ke baare mein pata nahi, manager dekhte hain",
  "loan reject pehle se kam ho rahe hain",
  "ji theek hai, dhanyavaad",
];

runScript(async () => {
  loadLocalEnv();
  const voice = voiceFromEnv();
  if (!voice) throw new Error("GNANI_API_KEY and CLAUDE_API_KEY must both be set in .env");
  const withSpeech = process.argv.includes("--speak");
  const codes = GNANI_LANGUAGE.hi;
  const before = voice.budget.state();

  const turns: Turn[] = [{ role: "agent", text: openingLine("hi", dealer) }];
  if (withSpeech) await speak(voice, turns[0]!.text, codes.tts);
  console.log(`agent : ${turns[0]!.text}`);

  for (const line of DEALER_LINES) {
    turns.push({ role: "dealer", text: line });
    console.log(`dealer: ${line}`);
    const reply = readReply(await voice.claude.reply(agentSystemPrompt(def, "hi", dealer), toMessages(turns)));
    if (reply.text) turns.push({ role: "agent", text: reply.text });
    if (reply.text && withSpeech) await speak(voice, reply.text, codes.tts);
    console.log(`agent : ${reply.text}${reply.ended ? "   [call ends]" : ""}`);
    if (reply.ended) break;
  }

  const transcript = turns.map((t) => `${t.role === "dealer" ? "user" : "assistant"}: ${t.text}`).join("\n");
  const extraction = await voice.claude.extract(extractionPrompt(def), transcript, extractionSchema(def));
  const call = interpretExecution(
    def,
    buildExecution({
      def,
      turns,
      extraction,
      durationS: 90,
      agentId: "nabz-gnani-voice-agent",
      executionId: crypto.randomUUID(),
      now: new Date(),
      costCents: 1,
    }),
    null,
  );

  console.log(`\nstatus: ${call.derivedStatus}, outcome: ${call.outcome}, QA: ${call.qaState}`);
  for (const q of def.questions) {
    const status = call.extracted[q.key]?.status;
    console.log(`  ${q.key.padEnd(16)} ${String(call.answers[q.key] ?? `(${status})`)}`);
  }
  const after = voice.budget.state();
  console.log(
    `\nSpent: $${(after.claudeUsd - before.claudeUsd).toFixed(4)} Claude (${after.claudeCalls - before.claudeCalls} calls), ` +
      `${(after.gnaniCredits - before.gnaniCredits).toFixed(2)} Gnani credits (padded estimate).`,
  );
  console.log(`Totals: $${after.claudeUsd.toFixed(4)} / $9, ${after.gnaniCredits.toFixed(2)} / 4000 credits.`);
});
