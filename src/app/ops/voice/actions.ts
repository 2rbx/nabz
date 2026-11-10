"use server";

import { interpretExecution } from "@/lib/calls/ingest/interpret";
import { ClaudeRefusal } from "@/lib/claude/client";
import { GnaniError } from "@/lib/gnani/client";
import { vehiclePulseV2 as definition } from "@/lib/surveys/definitions/vehicle-pulse.v2";
import {
  agentSystemPrompt,
  buildExecution,
  extractionPrompt,
  extractionSchema,
  GNANI_LANGUAGE,
  openingLine,
  readReply,
  toMessages,
  type AgentLanguage,
  type DealerContext,
  type Turn,
} from "@/lib/voice/agent";
import { BudgetExceeded } from "@/lib/voice/budget";
import { speak, voiceFromEnv } from "@/lib/voice/runtime";

/**
 * One demo call, a turn at a time. The page holds the conversation and sends it back each turn, so these
 * actions keep no state. Every Gnani and Claude request goes through the budget guard (src/lib/voice).
 *
 * The dealer is synthetic (a made-up showroom): this is a demonstration, no real number is ever dialled.
 */

const DEMO_DEALER: DealerContext = { businessName: "Demo Motors", brand: "Hero", city: "Lucknow" };
/** A hard stop on the length of a call, so a runaway conversation can't spend the budget. */
const MAX_DEALER_TURNS = 12;
/** Recordings are 16 kHz mono 16-bit WAV (the page converts them), with a 44-byte header. */
const WAV_BYTES_PER_SECOND = 32000;

export type AnswerView = { key: string; label: string; status: string; value: string | number | null };

export type CallResult = {
  derivedStatus: string;
  outcome: string | null;
  qaState: string;
  answers: AnswerView[];
  flags: string[];
};

export type SpendView = { claudeUsd: number; gnaniCredits: number; claudeCalls: number };

export type TurnState =
  | {
      ok: true;
      turns: Turn[];
      /** The agent's newest line, spoken: base64 MP3. */
      audio: string | null;
      ended: boolean;
      result: CallResult | null;
      spend: SpendView;
    }
  | { ok: false; message: string; spend: SpendView | null };

const spendOf = (voice: NonNullable<ReturnType<typeof voiceFromEnv>>): SpendView => {
  const s = voice.budget.state();
  return { claudeUsd: s.claudeUsd, gnaniCredits: s.gnaniCredits, claudeCalls: s.claudeCalls };
};

function failure(error: unknown, voice: ReturnType<typeof voiceFromEnv>): TurnState {
  const spend = voice ? spendOf(voice) : null;
  if (error instanceof BudgetExceeded) return { ok: false, message: error.message, spend };
  if (error instanceof GnaniError) return { ok: false, message: `Gnani said no: ${error.message}`, spend };
  if (error instanceof ClaudeRefusal) return { ok: false, message: error.message, spend };
  return { ok: false, message: error instanceof Error ? error.message : String(error), spend };
}

function parseLanguage(value: string): AgentLanguage {
  return value === "en" ? "en" : "hi";
}

/** Dials nobody: speaks the agent's opening line (free after the first time: it is cached). */
export async function startCall(languageInput: string): Promise<TurnState> {
  const voice = voiceFromEnv();
  if (!voice) return { ok: false, message: "GNANI_API_KEY and CLAUDE_API_KEY must both be set in .env.", spend: null };
  const language = parseLanguage(languageInput);
  try {
    const text = openingLine(language, DEMO_DEALER);
    const { audioBase64 } = await speak(voice, text, GNANI_LANGUAGE[language].tts);
    return {
      ok: true,
      turns: [{ role: "agent", text }],
      audio: audioBase64,
      ended: false,
      result: null,
      spend: spendOf(voice),
    };
  } catch (error) {
    return failure(error, voice);
  }
}

export type DealerInput = {
  language: string;
  turns: Turn[];
  /** What the dealer said, typed (no Gnani speech-to-text credits). Or: */
  text?: string;
  /** a recording, base64 WAV, 16 kHz mono. */
  audioWavBase64?: string;
  /** Seconds since the call began, for the stored call's duration. */
  elapsedS: number;
};

export async function dealerTurn(input: DealerInput): Promise<TurnState> {
  const voice = voiceFromEnv();
  if (!voice) return { ok: false, message: "GNANI_API_KEY and CLAUDE_API_KEY must both be set in .env.", spend: null };
  const language = parseLanguage(input.language);
  const codes = GNANI_LANGUAGE[language];
  try {
    let dealerText = input.text?.trim() ?? "";
    if (!dealerText && input.audioWavBase64) {
      const wav = Buffer.from(input.audioWavBase64, "base64");
      const seconds = Math.max(1, (wav.length - 44) / WAV_BYTES_PER_SECOND);
      const heard = await voice.gnani.stt(wav, "dealer.wav", seconds, { languageCode: codes.stt });
      dealerText = heard.transcript;
    }
    if (!dealerText) return { ok: false, message: "Nothing was heard. Try again, or type the reply.", spend: spendOf(voice) };

    const turns: Turn[] = [...input.turns, { role: "dealer", text: dealerText }];
    const dealerTurns = turns.filter((t) => t.role === "dealer").length;

    const raw = await voice.claude.reply(agentSystemPrompt(definition, language, DEMO_DEALER), toMessages(turns));
    const reply = readReply(raw);
    const ended = reply.ended || dealerTurns >= MAX_DEALER_TURNS;
    if (reply.text) turns.push({ role: "agent", text: reply.text });
    const audio = reply.text ? (await speak(voice, reply.text, codes.tts)).audioBase64 : null;

    let result: CallResult | null = null;
    if (ended) result = await finish(voice, turns, Math.max(1, input.elapsedS));
    return { ok: true, turns, audio, ended, result, spend: spendOf(voice) };
  } catch (error) {
    return failure(error, voice);
  }
}

/** Reads the finished conversation into answers, through the same interpretation real calls get. */
async function finish(voice: NonNullable<ReturnType<typeof voiceFromEnv>>, turns: Turn[], durationS: number): Promise<CallResult> {
  const transcript = turns.map((t) => `${t.role === "dealer" ? "user" : "assistant"}: ${t.text}`).join("\n");
  const before = voice.budget.state();
  const extraction = await voice.claude.extract(extractionPrompt(definition), transcript, extractionSchema(definition));
  const after = voice.budget.state();
  const execution = buildExecution({
    def: definition,
    turns,
    extraction,
    durationS,
    agentId: "nabz-gnani-voice-agent",
    executionId: crypto.randomUUID(),
    now: new Date(),
    costCents: Math.ceil((after.claudeUsd - before.claudeUsd) * 100),
  });
  const call = interpretExecution(definition, execution, null);
  return {
    derivedStatus: call.derivedStatus,
    outcome: call.outcome,
    qaState: call.qaState,
    flags: call.flags.flatMap((f) => (f.detail ? [f.detail] : [])),
    answers: definition.questions.map((q) => ({
      key: q.key,
      label: q.label.en,
      status: call.extracted[q.key]?.status ?? "not_asked",
      value: call.answers[q.key] ?? null,
    })),
  };
}
