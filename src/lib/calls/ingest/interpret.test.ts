import { describe, expect, it } from "vitest";
import type { VoiceExecution } from "../execution";
import { vehiclePulseV2 as def } from "../../surveys/definitions/vehicle-pulse.v2";
import en01 from "./fixtures/en01-completed.json";
import hi04Owner from "./fixtures/hi04-owner-stock-unclear.json";
import hi04Second from "./fixtures/hi04-second-number.json";
import od01 from "./fixtures/od01-completed.json";
import ta02 from "./fixtures/ta02-extraction-missing.json";
import ta02Reextracted from "./fixtures/ta02-reextracted.json";
import { parseExecutionTime, interpretExecution } from "./interpret";

const asExecution = (x: unknown) => x as VoiceExecution;
const codes = (flags: { code: string }[]) => flags.map((f) => f.code).sort();

/**
 * Our real calls (29 Oct 2026), personal fields scrubbed. Expected values were checked by hand
 * against each transcript (call-lab logs: langs/LOG.md, hindi/LOG.md, tamil/LOG.md).
 */
describe("real calls", () => {
  it("en01: a clean English call, all six answered", () => {
    const c = interpretExecution(def, asExecution(en01), null);
    expect(c).toMatchObject({
      executionStatus: "completed",
      terminal: true,
      derivedStatus: "completed",
      outcome: "completed",
      answeredCount: 5,
      qaState: "auto_ok",
      durationS: 96,
      costCents: 12,
      hangupBy: "Plivo",
      hangupReason: "end_call_tool",
      callbackTimeText: null,
      extractionMissing: false,
    });
    expect(c.answers).toEqual({
      enquiries_trend: "same",
      bookings_trend: "same",
      bookings_week: 20,
      stock_days: 15,
      discount_trend: "down",
      loan_rejections: "low",
    });
    expect(codes(c.flags)).toEqual([]);
    expect(c.extracted.stock_days).toEqual({ raw: "15", value: 15, confidence: 0.95, valid: true, status: "answered" });
    // initiated_at has no offset and is UTC; the call ended at the last update.
    expect(c.initiatedAt.toISOString()).toBe("2026-10-28T23:53:50.987Z");
    expect(c.endedAt?.toISOString()).toBe("2026-10-28T23:55:42.020Z");
    expect(c.startedAt?.toISOString()).toBe("2026-10-28T23:54:06.020Z");
  });

  it("hi04 (owner): stock garbled to nothing is unclear, not a failed value, and the call still counts", () => {
    const c = interpretExecution(def, asExecution(hi04Owner), null);
    expect(c).toMatchObject({ derivedStatus: "completed", answeredCount: 4, qaState: "auto_ok" });
    expect(c.answers).toEqual({
      enquiries_trend: "down",
      bookings_trend: "down",
      bookings_week: 50,
      discount_trend: "down",
      loan_rejections: "low",
    });
    // The agent returned an empty value and its companion said "unclear": a reason, not a bad value.
    expect(c.extracted.stock_days).toEqual({ raw: null, value: null, confidence: null, valid: null, status: "unclear" });
    expect(codes(c.flags)).toEqual(["missing_answers"]);
  });

  it("hi04 (second number): the agent's own 'unclear' is recorded as such; a non-number count is a failed value", () => {
    const c = interpretExecution(def, asExecution(hi04Second), null);
    expect(c).toMatchObject({
      derivedStatus: "completed",
      answeredCount: 4,
      qaState: "auto_ok",
      costCents: 18,
      hangupBy: "Callee",
    });
    expect(c.extracted.enquiries_trend).toMatchObject({ status: "unclear", valid: null, confidence: null });
    expect(c.extracted.bookings_week).toMatchObject({ raw: "unclear", status: "unclear" });
    expect(c.answers).toEqual({ bookings_trend: "same", stock_days: 15, discount_trend: "same", loan_rejections: "high" });
  });

  it("od01: an Odia call, recorded as the voice agent extracted it", () => {
    const c = interpretExecution(def, asExecution(od01), null);
    expect(c).toMatchObject({ derivedStatus: "completed", answeredCount: 5, qaState: "auto_ok" });
    // 2,000 is what was said and exactly the allowed maximum. Loans "high" is the agent's (wrong) reading
    // of "ସେତିକି" (the same), noted in the lab log; ingestion records what the extraction said.
    expect(c.answers).toMatchObject({ bookings_week: 2000, stock_days: 10, loan_rejections: "high" });
  });

  it("ta02: a real conversation with no extraction is held, with nothing invented", () => {
    const c = interpretExecution(def, asExecution(ta02), null);
    expect(c).toMatchObject({
      derivedStatus: "partial",
      answeredCount: 0,
      qaState: "needs_review",
      extractionMissing: true,
      outcome: null,
    });
    expect(c.answers).toEqual({});
    expect(codes(c.flags)).toEqual(["extraction_missing"]);
    expect(Object.values(c.extracted).every((e) => e.status === "not_asked")).toBe(true);
  });
});

/** A small conversation to vary: two dealer lines and a Pulse built from `pulse`. */
function call(patch: Partial<VoiceExecution> & { pulse?: Record<string, unknown> } = {}): VoiceExecution {
  const { pulse, ...rest } = patch;
  return {
    id: "exec-1",
    agent_id: "agent-1",
    status: "completed",
    conversation_duration: 80,
    total_cost: 10,
    transcript: "assistant: Namaste.\nuser: Haan ji.\nassistant: Shuru karein?\nuser: Haan.",
    initiated_at: "2026-10-27T05:00:00.000000",
    created_at: "2026-10-27T05:00:00.000000+00:00",
    updated_at: "2026-10-27T05:02:00.000000+00:00",
    extracted_data: { Pulse: (pulse ?? FULL) as Record<string, Record<string, unknown>> },
    ...rest,
  };
}

const choice = (objective: string, confidence = 0.9) => ({ objective, subjective: null, confidence, validation: null });
const number = (subjective: string, isValid: boolean | null = true, confidence = 0.9) => ({
  objective: null,
  subjective,
  confidence,
  validation: isValid === null ? null : { is_valid: isValid, expected_type: "numeric" },
});
const FULL = {
  outcome: choice("completed"),
  enquiries_trend: choice("up"),
  bookings_trend: choice("up"),
  bookings_week: number("40"),
  bookings_week_status: choice("answered"),
  stock_days: number("21"),
  stock_days_status: choice("answered"),
  discount_trend: choice("same"),
  loan_rejections: choice("normal"),
  callback_time: { objective: null, subjective: "", confidence: 0, validation: null },
};

describe("statuses", () => {
  it.each([
    ["queued", "queued"],
    ["initiated", "queued"],
    ["ringing", "queued"],
    ["in-progress", "in_progress"],
    ["call-disconnected", "in_progress"],
  ])("%s is not final: no answers, no QA yet", (status, derived) => {
    const c = interpretExecution(def, call({ status }), null);
    expect(c).toMatchObject({ derivedStatus: derived, terminal: false, qaState: "pending", answers: {}, endedAt: null });
    expect(c.flags).toEqual([]);
  });

  it.each([
    ["no-answer", "no_answer"],
    ["busy", "busy"],
    ["failed", "failed"],
    ["canceled", "error"],
    ["stopped", "error"],
    ["balance-low", "error"],
    ["error", "error"],
  ])("%s ends as %s, with nothing to check", (status, derived) => {
    const c = interpretExecution(def, call({ status, conversation_duration: 0, transcript: null, extracted_data: null }), null);
    expect(c).toMatchObject({ derivedStatus: derived, terminal: true, qaState: "auto_ok", answeredCount: 0 });
  });

  it("keeps the agent's error message, or the termination reason, for a call that errored", () => {
    const c = interpretExecution(
      def,
      call({ status: "balance-low", conversation_duration: 0, transcript: null, termination_reason: "insufficient balance" }),
      null,
    );
    expect(c.errorMessage).toBe("insufficient balance");
  });

  it("an answering machine is voicemail", () => {
    expect(interpretExecution(def, call({ answered_by_voice_mail: true }), null).derivedStatus).toBe("voicemail");
  });

  it("completed with nobody speaking is no answer, whatever the extraction says (spec L208)", () => {
    const silent = interpretExecution(def, call({ transcript: "assistant: Namaste.\nassistant: Hello?" }), null);
    // The voice agent may still return an extraction for it; with nobody speaking, it's a guess and is ignored.
    expect(silent).toMatchObject({ derivedStatus: "no_answer", answers: {}, answeredCount: 0, outcome: null });
    expect(interpretExecution(def, call({ conversation_duration: 0 }), null).derivedStatus).toBe("no_answer");
  });
});

describe("the data decides the status (spec L224)", () => {
  it("a full call is completed", () => {
    const c = interpretExecution(def, call(), null);
    expect(c).toMatchObject({ derivedStatus: "completed", answeredCount: 5, qaState: "auto_ok" });
    expect(c.answers).toEqual({
      enquiries_trend: "up",
      bookings_trend: "up",
      bookings_week: 40,
      stock_days: 21,
      discount_trend: "same",
      loan_rejections: "normal",
    });
  });

  it("'refused' with four answers is a partial call", () => {
    const pulse = { ...FULL, outcome: choice("refused"), loan_rejections: choice("not_asked") };
    expect(interpretExecution(def, call({ pulse }), null).derivedStatus).toBe("partial");
  });

  it("'refused' with no answers stays refused", () => {
    const pulse = { outcome: choice("refused") };
    expect(interpretExecution(def, call({ pulse }), null)).toMatchObject({ derivedStatus: "refused", answeredCount: 0 });
  });

  it("the agents' opted_out reads as refused", () => {
    const pulse = { ...FULL, outcome: choice("opted_out"), discount_trend: choice("not_asked"), loan_rejections: choice("not_asked") };
    expect(interpretExecution(def, call({ pulse }), null)).toMatchObject({ derivedStatus: "partial", outcome: "refused" });
    const early = interpretExecution(def, call({ pulse: { outcome: choice("opted_out") } }), null);
    expect(early).toMatchObject({ derivedStatus: "refused", outcome: "refused" });
  });

  it("a wrong number only counts when the call really was one", () => {
    const c = interpretExecution(def, call({ pulse: { outcome: choice("wrong_number") } }), null);
    expect(c).toMatchObject({ derivedStatus: "wrong_number" });
    const answered = interpretExecution(def, call({ pulse: { ...FULL, outcome: choice("wrong_number") } }), null);
    expect(answered).toMatchObject({ derivedStatus: "completed" });
  });

  it("a callback request keeps the time the dealer gave", () => {
    const pulse = { outcome: choice("callback"), callback_time: { subjective: "shaam 6 baje", confidence: 0.9 } };
    expect(interpretExecution(def, call({ pulse }), null)).toMatchObject({
      derivedStatus: "callback",
      callbackTimeText: "shaam 6 baje",
    });
  });

  it("'completed' with no answers is excluded by QA as a false completion", () => {
    const pulse = { outcome: choice("completed"), enquiries_trend: choice("dont_know"), bookings_trend: choice("dont_know") };
    const c = interpretExecution(
      def,
      call({ pulse: { ...pulse, stock_days_status: choice("dont_know"), discount_trend: choice("declined"), loan_rejections: choice("dont_know") } }),
      null,
    );
    expect(c).toMatchObject({ derivedStatus: "completed", qaState: "excluded" });
    expect(codes(c.flags)).toContain("false_completed");
  });
});

describe("reading the extraction", () => {
  const read = (pulse: Record<string, unknown>) => interpretExecution(def, call({ pulse: { ...FULL, ...pulse } }), null);

  it("numbers: commas, decimals, ranges of allowed values", () => {
    expect(read({ bookings_week: number("1,200") }).answers.bookings_week).toBe(1200);
    expect(read({ bookings_week: number("12.6") }).answers.bookings_week).toBe(13);
    expect(read({ bookings_week: number(" 40 ") }).answers.bookings_week).toBe(40);
  });

  it.each([
    ["over the maximum", number("2500")],
    ["not a number", number("twenty")],
    ["failed the agent's validation", number("15", false)],
    ["negative", number("-3")],
  ])("a count %s is a failed value: unclear and held for a person", (_label, value) => {
    const c = read({ stock_days: value });
    expect(c.answers.stock_days).toBeUndefined();
    expect(c.extracted.stock_days).toMatchObject({ valid: false, status: "unclear", value: null });
    expect(c.qaState).toBe("needs_review");
    expect(codes(c.flags)).toContain("invalid_answer");
  });

  it("an empty number takes its reason from the companion field", () => {
    const c = read({ stock_days: number("", null, 0), stock_days_status: choice("dont_know") });
    expect(c.extracted.stock_days).toEqual({ raw: null, value: null, confidence: null, valid: null, status: "dont_know" });
    expect(read({ stock_days: number("", null, 0), stock_days_status: undefined }).extracted.stock_days?.status).toBe(
      "not_asked",
    );
  });

  it("choices: reasons, the agent's unclear, the legacy not_answered, and unknown values", () => {
    expect(read({ loan_rejections: choice("dont_know") }).extracted.loan_rejections?.status).toBe("dont_know");
    expect(read({ loan_rejections: choice("declined") }).extracted.loan_rejections?.status).toBe("declined");
    expect(read({ loan_rejections: choice("unclear") }).extracted.loan_rejections).toMatchObject({
      status: "unclear",
      valid: null,
    });
    expect(read({ loan_rejections: choice("not_answered") }).extracted.loan_rejections?.status).toBe("not_asked");
    expect(read({ loan_rejections: choice(" High ") }).answers.loan_rejections).toBe("high");
    const unknown = read({ loan_rejections: choice("maybe") });
    expect(unknown.extracted.loan_rejections).toMatchObject({ raw: "maybe", valid: false, status: "unclear" });
    expect(codes(unknown.flags)).toContain("invalid_answer");
  });

  it("stores confidence only for answers (the agent's 0 on empty fields would trigger low-confidence holds)", () => {
    const c = read({ discount_trend: { objective: null, subjective: null, confidence: 0 } });
    expect(c.extracted.discount_trend).toMatchObject({ status: "not_asked", confidence: null });
    expect(codes(c.flags)).not.toContain("low_confidence");
  });

  it("a low-confidence answer is still held for review", () => {
    expect(codes(read({ enquiries_trend: choice("up", 0.3) }).flags)).toContain("low_confidence");
  });

  it("an ops correction wins over the extraction, and a null correction removes an answer", () => {
    const c = interpretExecution(def, call(), null, { overrides: { stock_days: 25, loan_rejections: null } });
    expect(c.answers).toMatchObject({ stock_days: 25 });
    expect(c.answers.loan_rejections).toBeUndefined();
    expect(c.answeredCount).toBe(4);
    // A removed answer is unclear (a response), so the call stays completed; the agent's reading is kept.
    expect(c.derivedStatus).toBe("completed");
    expect(c.extracted.loan_rejections).toMatchObject({ value: "normal", status: "answered" });
  });

  it("a corrected value is no longer held for the agent's doubts about it", () => {
    const pulse = { ...FULL, stock_days: number("twenty"), enquiries_trend: choice("up", 0.3) };
    const held = interpretExecution(def, call({ pulse }), null);
    expect(codes(held.flags)).toEqual(expect.arrayContaining(["invalid_answer", "low_confidence"]));
    const fixed = interpretExecution(def, call({ pulse }), null, { overrides: { stock_days: 20, enquiries_trend: "up" } });
    expect(codes(fixed.flags)).not.toContain("invalid_answer");
    expect(codes(fixed.flags)).not.toContain("low_confidence");
    expect(fixed).toMatchObject({ qaState: "auto_ok", answeredCount: 5 });
  });
});

describe("parseExecutionTime", () => {
  it("reads the two timestamp styles", () => {
    expect(parseExecutionTime("2026-10-28T23:46:23.891298")?.toISOString()).toBe("2026-10-28T23:46:23.891Z");
    expect(parseExecutionTime("2026-10-28T23:46:23.891298+00:00")?.toISOString()).toBe("2026-10-28T23:46:23.891Z");
    expect(parseExecutionTime("2026-10-29T05:16:23+05:30")?.toISOString()).toBe("2026-10-28T23:46:23.000Z");
    expect(parseExecutionTime("")).toBeNull();
    expect(parseExecutionTime("not a date")).toBeNull();
    expect(parseExecutionTime(null)).toBeNull();
  });
});

describe("the extraction fallback", () => {
  it("ta02: re-reading the transcript gives the call its answers, counted, with a note saying how", () => {
    // The real fallback: the ta02 agent's extractions run on this call's transcript (30 Oct, free).
    const c = interpretExecution(def, asExecution(ta02), null, { reextracted: ta02Reextracted.extracted_data });
    expect(c).toMatchObject({
      derivedStatus: "completed",
      answeredCount: 5,
      qaState: "auto_ok",
      extractionSource: "reextract",
      extractionMissing: false,
      outcome: "completed",
    });
    // Checked against the transcript: "கொஞ்சம் கம்மியாயிடுச்சு" (a bit lower), lower, "பன்னண்டு" (12),
    // more, more. Stock: the dealer said "about three weeks" (21 days) and the extractor gave 24;
    // ingestion records what the extraction said (an extraction-wording issue for the lab).
    expect(c.answers).toEqual({
      enquiries_trend: "down",
      bookings_trend: "down",
      bookings_week: 12,
      stock_days: 24,
      discount_trend: "up",
      loan_rejections: "high",
    });
    expect(c.flags).toEqual([expect.objectContaining({ code: "reextracted", severity: "info" })]);
  });

  it("the agent's own extraction always wins over a re-extraction", () => {
    const c = interpretExecution(def, call(), null, { reextracted: { Pulse: { ...FULL, enquiries_trend: choice("down") } } });
    expect(c).toMatchObject({ extractionSource: "agent", answers: { enquiries_trend: "up" } });
    expect(codes(c.flags)).not.toContain("reextracted");
  });

  it("a re-extraction that also came back empty leaves the call held, with nothing invented", () => {
    const c = interpretExecution(def, call({ pulse: {} }), null, { reextracted: { Pulse: {} } });
    expect(c).toMatchObject({ extractionSource: null, extractionMissing: true, qaState: "needs_review", answers: {} });
    expect(codes(c.flags)).toEqual(["extraction_missing"]);
  });

  it("is never used for a call nobody spoke on", () => {
    const silent = call({ pulse: {}, transcript: "assistant: Namaste.\nassistant: Hello?" });
    const c = interpretExecution(def, silent, null, { reextracted: { Pulse: FULL } });
    expect(c).toMatchObject({ derivedStatus: "no_answer", extractionSource: null, answers: {} });
  });
});
