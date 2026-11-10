import { describe, expect, it } from "vitest";
import { vehiclePulseV2 as def } from "../surveys/definitions/vehicle-pulse.v2";
import type { Question } from "../surveys/schema";
import { hangupLabel, statusLabel } from "./report";
import { correctable, parseCorrection, QA_LABEL, reviewable, reviewDecisions } from "./review";

const question = (key: string) => def.questions.find((q) => q.key === key) as Question;

describe("reviewDecisions", () => {
  it("offers Approve only on a call that isn't counting", () => {
    expect(reviewDecisions("auto_ok")).toEqual(["excluded"]);
    expect(reviewDecisions("approved")).toEqual(["excluded"]);
    expect(reviewDecisions("needs_review")).toEqual(["approved", "excluded"]);
    expect(reviewDecisions("excluded")).toEqual(["approved"]);
  });
});

describe("parseCorrection", () => {
  it("accepts a question's own options, in any case", () => {
    expect(parseCorrection(question("enquiries_trend"), " Down ")).toEqual({ ok: true, value: "down" });
    expect(parseCorrection(question("loan_rejections"), "normal")).toEqual({ ok: true, value: "normal" });
    expect(parseCorrection(question("loan_rejections"), "medium")).toEqual({
      ok: false,
      error: "Choose one of: high, normal, low.",
    });
  });

  it("accepts a number in range, rounding counts", () => {
    expect(parseCorrection(question("stock_days"), "21")).toEqual({ ok: true, value: 21 });
    expect(parseCorrection(question("bookings_week"), "1,200")).toEqual({ ok: true, value: 1200 });
    expect(parseCorrection(question("stock_days"), "20.6")).toEqual({ ok: true, value: 21 });
    expect(parseCorrection(question("stock_days"), "400")).toMatchObject({ ok: false, error: "Must be between 0 and 365." });
    expect(parseCorrection(question("stock_days"), "twenty")).toEqual({ ok: false, error: "Enter a number." });
  });

  it("'not answered' removes the answer; nothing at all is refused", () => {
    expect(parseCorrection(question("stock_days"), "not_answered")).toEqual({ ok: true, value: null });
    expect(parseCorrection(question("stock_days"), "  ")).toMatchObject({ ok: false });
  });
});

describe("what can be reviewed", () => {
  it("only finished calls where the dealer talked", () => {
    for (const s of ["completed", "partial", "refused", "callback", "wrong_number"]) {
      expect(reviewable({ derivedStatus: s, statusRank: 10 })).toBe(true);
    }
    for (const s of ["no_answer", "busy", "failed", "voicemail", "error"]) {
      expect(reviewable({ derivedStatus: s, statusRank: 10 })).toBe(false);
    }
    expect(reviewable({ derivedStatus: "in_progress", statusRank: 4 })).toBe(false);
    expect(reviewable({ derivedStatus: "completed", statusRank: 5 })).toBe(false);
  });

  it("only calls with the execution can be corrected", () => {
    const call = { derivedStatus: "completed", statusRank: 10, hasRawExecution: true };
    expect(correctable(call)).toBe(true);
    expect(correctable({ ...call, hasRawExecution: false })).toBe(false);
    expect(correctable({ ...call, derivedStatus: "no_answer" })).toBe(false);
  });
});

describe("labels", () => {
  it("say what a status and a QA state mean", () => {
    expect(QA_LABEL.needs_review).toEqual({ label: "Needs review", tone: "warn" });
    expect(QA_LABEL.auto_ok.label).toBe("Counts");
    expect(statusLabel("in_progress")).toEqual({ label: "In progress", tone: "accent" });
    expect(statusLabel("something_new")).toEqual({ label: "something new", tone: "neutral" });
  });
});

describe("hangupLabel", () => {
  it("names who ended the call, as the voice agent reports it on our calls", () => {
    expect(hangupLabel("Callee", "Call recipient hungup")).toBe("Dealer");
    expect(hangupLabel("Plivo", "end_call_tool")).toBe("Agent");
    expect(hangupLabel("Plivo", "inactivity_timeout")).toBe("Agent, after silence");
    expect(hangupLabel("Carrier", "Call recipient rejected")).toBe("Network: call recipient rejected");
    expect(hangupLabel("Plivo", "something_else")).toBe("Plivo: something_else");
    expect(hangupLabel(null, null)).toBeNull();
  });
});
