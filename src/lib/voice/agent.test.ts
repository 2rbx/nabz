import { describe, expect, it, vi } from "vitest";
import { interpretExecution } from "../calls/ingest/interpret";
import { createClaudeClient, type ClaudeSdk } from "../claude/client";
import { vehiclePulseV2 as def } from "../surveys/definitions/vehicle-pulse.v2";
import {
  agentSystemPrompt,
  buildExecution,
  END_MARKER,
  extractionPrompt,
  extractionSchema,
  openingLine,
  readReply,
  toMessages,
  type Turn,
} from "./agent";
import { BudgetExceeded, createBudget, EMPTY_BUDGET, memoryStore } from "./budget";

const dealer = { businessName: "Sharma Motors", brand: "Hero", city: "Lucknow" };

const turns: Turn[] = [
  { role: "agent", text: openingLine("hi", dealer) },
  { role: "dealer", text: "haan boliye" },
  { role: "agent", text: "इस हफ्ते enquiries बढ़ीं या कम हुईं?" },
  { role: "dealer", text: "thodi badhi hain" },
];

const extraction = {
  enquiries_trend: { value: "up", status: "answered" },
  bookings_trend: { value: "same", status: "answered" },
  bookings_week: { value: 25, status: "answered" },
  stock_days: { value: 45, status: "answered" },
  discount_trend: { value: null, status: "dont_know" },
  loan_rejections: { value: "low", status: "answered" },
  outcome: "completed",
  callback_time: null,
};

describe("the agent's words", () => {
  it("opens by saying it is an AI, in both languages", () => {
    expect(openingLine("hi", dealer)).toContain("AI");
    expect(openingLine("en", dealer)).toContain("AI assistant");
  });

  it("asks the survey's six questions in order, in the right language", () => {
    const hi = agentSystemPrompt(def, "hi", dealer);
    expect(hi.indexOf("Pichhle hafte se is hafte enquiries")).toBeLessThan(hi.indexOf("Aakhri sawaal"));
    expect(hi).toContain("Devanagari");
    const en = agentSystemPrompt(def, "en", dealer);
    expect(en).toContain("Were enquiries this week higher than last week");
    expect(en).toContain(END_MARKER);
  });

  it("separates the end marker from the words to speak", () => {
    expect(readReply(`धन्यवाद! ${END_MARKER}`)).toEqual({ text: "धन्यवाद!", ended: true });
    expect(readReply("अगला सवाल")).toEqual({ text: "अगला सवाल", ended: false });
  });

  it("starts the messages with a user turn", () => {
    const messages = toMessages(turns);
    expect(messages[0]).toEqual({ role: "user", content: "(call connected)" });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });
});

describe("extraction", () => {
  it("covers every question plus the outcome, and the prompt carries each instruction", () => {
    const schema = extractionSchema(def) as { required: string[] };
    expect(schema.required).toEqual([...def.questions.map((q) => q.key), "outcome", "callback_time"]);
    const prompt = extractionPrompt(def);
    for (const q of def.questions) expect(prompt).toContain(q.key);
  });
});

describe("a finished conversation goes through the unchanged ingest rules", () => {
  const execution = buildExecution({
    def,
    turns,
    extraction,
    durationS: 95,
    agentId: "gnani-agent-hi",
    executionId: "exec-1",
    now: new Date("2026-11-10T10:00:00Z"),
    costCents: 2,
  });

  it("reads as a completed call with the real answers and the reason for the gap", () => {
    const call = interpretExecution(def, execution, null);
    expect(call.derivedStatus).toBe("completed");
    expect(call.outcome).toBe("completed");
    expect(call.answers).toEqual({
      enquiries_trend: "up",
      bookings_trend: "same",
      bookings_week: 25,
      stock_days: 45,
      loan_rejections: "low",
    });
    // "Didn't know" is a reason, never a made-up answer.
    expect(call.answers).not.toHaveProperty("discount_trend");
    expect(call.extracted.discount_trend?.status).toBe("dont_know");
    expect(call.transcript).toContain("user: haan boliye");
  });

  it("marks a question the dealer never reached as not asked", () => {
    const partial = buildExecution({
      def,
      turns,
      extraction: { ...extraction, loan_rejections: { value: null, status: "not_asked" }, outcome: "partial" },
      durationS: 40,
      agentId: "gnani-agent-hi",
      executionId: "exec-2",
      now: new Date("2026-11-10T10:00:00Z"),
      costCents: 1,
    });
    const call = interpretExecution(def, partial, null);
    expect(call.extracted.loan_rejections?.status).toBe("not_asked");
    expect(call.derivedStatus).not.toBe("completed");
  });
});

describe("the Claude client", () => {
  const message = (text: string, input = 3000, output = 60) =>
    ({ content: [{ type: "text", text }], usage: { input_tokens: input, output_tokens: output }, stop_reason: "end_turn" }) as never;

  it("charges the budget from the real token counts and returns the text", async () => {
    const store = memoryStore();
    const sdk: ClaudeSdk = { messages: { create: vi.fn(async () => message("अगला सवाल")) } };
    const claude = createClaudeClient({ budget: createBudget(store), sdk });

    expect(await claude.reply("system", [{ role: "user", content: "hi" }])).toBe("अगला सवाल");
    expect(store.current.claudeCalls).toBe(1);
    // 3,000 in and 60 out on Haiku 5.5.
    expect(store.current.claudeUsd).toBeCloseTo((3000 * 0.1 + 60 * 0.5) / 1_000_000);
    const params = (sdk.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.thinking).toEqual({ type: "disabled" });
  });

  it("extracts JSON with the schema", async () => {
    const sdk: ClaudeSdk = { messages: { create: vi.fn(async () => message(JSON.stringify(extraction))) } };
    const claude = createClaudeClient({ budget: createBudget(memoryStore()), sdk });
    expect(await claude.extract("sys", "user: x", extractionSchema(def))).toEqual(extraction);
    const params = (sdk.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      model: string;
      output_config: { format: { type: string } };
    };
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.output_config.format.type).toBe("json_schema");
  });

  it("sends nothing once the $9 cap would be passed", async () => {
    const create = vi.fn();
    const claude = createClaudeClient({
      budget: createBudget(memoryStore({ ...EMPTY_BUDGET, claudeUsd: 8.999 })),
      sdk: { messages: { create } },
    });
    await expect(claude.extract("sys", "user: x".repeat(500), extractionSchema(def))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(create).not.toHaveBeenCalled();
  });
});
