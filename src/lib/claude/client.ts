import Anthropic from "@anthropic-ai/sdk";
import type { Budget, ClaudeModel } from "../voice/budget";

/**
 * The only code that talks to Claude (ESLint enforces it). Two jobs, both behind the spend guard:
 * - `reply`: the agent's next spoken line. Haiku 5.5, thinking off, short.
 * - `extract`: the six answers out of a finished transcript as JSON. Sonnet 5.5.
 *
 * Every call checks the worst case against the Claude cap before it is sent, and is charged from the
 * real token counts after. Kept free of env reads: callers pass the key (or a stub client) in.
 */

export const REPLY_MODEL: ClaudeModel = "claude-haiku-5-5";
export const EXTRACT_MODEL: ClaudeModel = "claude-sonnet-5-5";

/** Hindi and Hinglish tokenise heavily; two characters per token keeps the estimate on the safe side. */
const CHARS_PER_TOKEN = 2;

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** The part of the SDK we use, so tests can pass a stub. */
export type ClaudeSdk = {
  messages: { create(params: Record<string, unknown>): Promise<Anthropic.Messages.Message> };
};

export type ClaudeClientOptions = { apiKey?: string; budget: Budget; sdk?: ClaudeSdk };

export class ClaudeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeRefusal";
  }
}

function textOf(message: Anthropic.Messages.Message): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

export function createClaudeClient(options: ClaudeClientOptions) {
  const sdk: ClaudeSdk =
    options.sdk ?? (new Anthropic({ apiKey: options.apiKey }) as unknown as ClaudeSdk);

  async function call(
    model: ClaudeModel,
    system: string,
    messages: ChatMessage[],
    maxTokens: number,
    extra: Record<string, unknown>,
  ): Promise<string> {
    const chars = system.length + messages.reduce((n, m) => n + m.content.length, 0);
    options.budget.ensureClaude(model, Math.ceil(chars / CHARS_PER_TOKEN), maxTokens);
    const message = await sdk.messages.create({ model, max_tokens: maxTokens, system, messages, ...extra });
    // Charged from what the API says it used (thinking tokens are in output_tokens).
    options.budget.chargeClaude(model, {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    });
    if (message.stop_reason === "refusal") throw new ClaudeRefusal("Claude declined this request.");
    return textOf(message);
  }

  return {
    /** The agent's next line. */
    reply(system: string, messages: ChatMessage[]): Promise<string> {
      return call(REPLY_MODEL, system, messages, 220, {
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
      });
    },

    /** Structured answers: the response is JSON matching `schema`. */
    async extract(system: string, transcript: string, schema: Record<string, unknown>): Promise<unknown> {
      const text = await call(EXTRACT_MODEL, system, [{ role: "user", content: transcript }], 1500, {
        output_config: { effort: "low", format: { type: "json_schema", schema } },
      });
      return JSON.parse(text);
    },
  };
}

export type ClaudeClient = ReturnType<typeof createClaudeClient>;
