import type { VoiceExecution } from "../calls/execution";
import { OUTCOMES, TREND_VALUES } from "../domain/constants";
import { extractionName, optionValues } from "../surveys/helpers";
import type { Question, SurveyDefinition } from "../surveys/schema";
import { STATUS_FIELD_SUFFIX } from "../calls/answer-status";
import type { ChatMessage } from "../claude/client";

/**
 * The Nabz voice agent's brain, as pure functions: the opening line, the system prompt built from the
 * survey definition, the extraction request, and the conversion of a finished conversation into the
 * execution shape the ingest already reads (`extracted_data.Pulse.<field>`). Nothing here calls Claude
 * or Gnani: src/lib/claude and src/lib/gnani do, behind the spend guard.
 *
 * Survey wording comes from the definition, so the agent asks exactly what the index scores.
 */

export type AgentLanguage = "hi" | "en";

/** Gnani language codes for each agent language (Timbre hi-en is Hinglish; Prisma uses hi-IN / en-IN). */
export const GNANI_LANGUAGE: Record<AgentLanguage, { stt: string; tts: string }> = {
  hi: { stt: "hi-IN", tts: "hi-IN" },
  en: { stt: "en-IN", tts: "en-IN" },
};

export type Turn = { role: "agent" | "dealer"; text: string };

export type DealerContext = { businessName: string; brand: string; city: string };

/** The agent ends the call by appending this to its last line. The user never hears it. */
export const END_MARKER = "[[END]]";

/** The first line is fixed, so it costs no Claude call and says it is an AI (a hard requirement). */
export function openingLine(language: AgentLanguage, d: DealerContext): string {
  return language === "hi"
    ? `नमस्ते, मैं नब्ज़ की AI असिस्टेंट बोल रही हूँ। क्या ये ${d.businessName} है? क्या मैं ओनर या सेल्स मैनेजर से दो मिनट बात कर सकती हूँ?`
    : `Hello, I'm Nabz's AI assistant. Is this ${d.businessName}? Could I take two minutes of the owner's or sales manager's time?`;
}

export function agentSystemPrompt(def: SurveyDefinition, language: AgentLanguage, d: DealerContext): string {
  const questions = def.questions
    .map((q, i) => `${i + 1}. ${language === "hi" ? q.ask.hinglish : q.ask.en}`)
    .join("\n");
  const speak =
    language === "hi"
      ? "Speak in Hindi written in Devanagari script, the way a polite Indian office assistant talks on the phone. Write English loanwords such as booking, stock, discount and loan in Devanagari too, so the speech engine reads them naturally."
      : "Speak in simple Indian English, the way a polite office assistant talks on the phone.";
  return `You are Nabz's AI phone assistant, calling ${d.businessName}${d.brand ? ` (${d.brand})` : ""} in ${d.city} for a two-minute weekly survey about their showroom. You already said hello and that you are an AI; the dealer has just replied.

${speak}

Ask these questions, one per turn, in this order:
${questions}

Rules:
- One short sentence per turn, 25 words at most. Plain speech: no lists, no markdown, no emoji, no digits spelled with symbols.
- Acknowledge the answer in two or three words, then ask the next question. Never repeat an answer back at length.
- If the dealer is unsure or doesn't know, accept it and move on. If they refuse a question, move on. Never push, never guess a number for them.
- If they are busy, ask once for a better time and end. If they say not to call again, apologise and end.
- If they ask who you are: Nabz, an AI assistant that collects a weekly demand reading from dealers. Never name other dealers or share anyone's numbers.
- After the last question (or when the call must end), thank them warmly in one sentence and end that message with ${END_MARKER}. Use ${END_MARKER} only on the final line.`;
}

/** Splits a reply into the words to speak and whether the call is over. */
export function readReply(raw: string): { text: string; ended: boolean } {
  const ended = raw.includes(END_MARKER);
  return { text: raw.replace(END_MARKER, "").trim(), ended };
}

/** The conversation as Claude sees it: the dealer is the user, the agent is the assistant. */
export function toMessages(turns: readonly Turn[]): ChatMessage[] {
  const messages: ChatMessage[] = turns.map((t) => ({
    role: t.role === "dealer" ? "user" : "assistant",
    content: t.text,
  }));
  // The API wants a user message first; the agent opened, so a connect note stands in.
  return messages[0]?.role === "assistant" ? [{ role: "user", content: "(call connected)" }, ...messages] : messages;
}

/** The transcript lines `conversationHappened` and the ops call view read. */
export function transcriptText(turns: readonly Turn[]): string {
  return turns.map((t) => `${t.role === "dealer" ? "user" : "assistant"}: ${t.text}`).join("\n");
}

const MISSING = ["dont_know", "declined", "not_asked"] as const;

function valueSchema(q: Question): Record<string, unknown> {
  const options = optionValues(q);
  // Nullable as anyOf: the structured-output schema checker rejects a type array beside an enum.
  if (options) return { anyOf: [{ type: "string", enum: [...options] }, { type: "null" }] };
  if (q.type === "number") return { anyOf: [{ type: "integer" }, { type: "null" }] };
  return { anyOf: [{ type: "string" }, { type: "null" }] };
}

/** JSON schema for the extraction: per question a value and a status, plus how the call ended. */
export function extractionSchema(def: SurveyDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const q of def.questions) {
    properties[q.key] = {
      type: "object",
      additionalProperties: false,
      required: ["value", "status"],
      properties: { value: valueSchema(q), status: { type: "string", enum: ["answered", ...MISSING] } },
    };
  }
  properties.outcome = { type: "string", enum: [...OUTCOMES] };
  properties.callback_time = { anyOf: [{ type: "string" }, { type: "null" }] };
  return { type: "object", additionalProperties: false, required: [...Object.keys(properties)], properties };
}

export function extractionPrompt(def: SurveyDefinition): string {
  const fields = def.questions
    .map((q) => {
      const hints = q.extraction.optionHints
        ? ` Options: ${Object.entries(q.extraction.optionHints)
            .map(([k, v]) => `${k} = ${v}`)
            .join(" ")}`
        : "";
      return `- ${q.key}: ${q.extraction.instruction}${hints}`;
    })
    .join("\n");
  return `You read a phone transcript between "assistant" (Nabz's AI) and "user" (a vehicle dealer) and fill in a survey. Use only what the dealer said, never the assistant's wording.

For each field give "value" and "status":
- answered: the dealer gave an answer; put it in value.
- dont_know: the dealer was asked and said they don't know; value null.
- declined: the dealer refused to answer; value null.
- not_asked: the question never came up; value null.

Fields:
${fields}

outcome: ${def.operational.outcome.extraction.instruction}
callback_time: ${def.operational.callbackTime.extraction.instruction}

Hindi may be in Devanagari or romanised. Never invent a value.`;
}

type Extraction = Record<string, { value: string | number | null; status: string } | string | null>;

/** One extracted question as the ingest's Pulse fields (choice answers in `objective`, numbers in `subjective`). */
function pulseFields(q: Question, e: { value: string | number | null; status: string } | undefined) {
  const name = extractionName(q);
  const answered = e?.status === "answered" && e.value !== null && e.value !== undefined;
  const status = e?.status && e.status !== "answered" ? e.status : "not_asked";
  if (q.type === "number") {
    return {
      [name]: { subjective: answered ? String(e!.value) : "" },
      [`${name}${STATUS_FIELD_SUFFIX}`]: { objective: answered ? "" : status },
    };
  }
  if (q.type === "text") return { [name]: { subjective: answered ? String(e!.value) : "" } };
  return { [name]: { objective: answered ? String(e!.value) : status } };
}

export type BuildExecutionInput = {
  def: SurveyDefinition;
  turns: readonly Turn[];
  extraction: unknown;
  /** The call's length in seconds (the dealer's recordings plus the agent's speech). */
  durationS: number;
  agentId: string;
  executionId: string;
  now: Date;
  /** What the call cost, in US cents (Claude + Gnani, as estimated by the budget). */
  costCents: number;
  /** Carried through so the ingest can link the call to its set recipient. */
  recipientData?: Record<string, string>;
};

/** A finished conversation, in the shape of a completed execution. The ingest reads it unchanged. */
export function buildExecution(input: BuildExecutionInput): VoiceExecution {
  const e = (input.extraction && typeof input.extraction === "object" ? input.extraction : {}) as Extraction;
  const pulse: Record<string, unknown> = {};
  for (const q of input.def.questions) {
    Object.assign(pulse, pulseFields(q, e[q.key] as { value: string | number | null; status: string } | undefined));
  }
  const outcome = typeof e.outcome === "string" ? e.outcome : null;
  if (outcome) pulse.outcome = { objective: outcome };
  const callback = typeof e.callback_time === "string" ? e.callback_time.trim() : "";
  if (callback) pulse.callback_time = { subjective: callback };
  const at = input.now.toISOString();
  return {
    id: input.executionId,
    agent_id: input.agentId,
    status: "completed",
    conversation_duration: Math.max(1, Math.round(input.durationS)),
    initiated_at: at.replace("Z", ""),
    created_at: at,
    updated_at: at,
    total_cost: input.costCents,
    transcript: transcriptText(input.turns),
    context_details: input.recipientData ? { recipient_data: input.recipientData } : null,
    extracted_data: { Pulse: pulse } as VoiceExecution["extracted_data"],
  };
}

/** Trend options, re-exported so the demo page can show them without importing domain constants. */
export const TRENDS = TREND_VALUES;
