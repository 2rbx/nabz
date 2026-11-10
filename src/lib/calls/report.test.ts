import { describe, expect, it } from "vitest";
import { vehiclePulseV1 } from "../surveys/definitions/vehicle-pulse.v1";
import { buildCallReport, type CallForReport, parseTranscript, type ReportInput } from "./report";

const answers = {
  enquiries_trend: "up",
  bookings_trend: "same",
  bookings_week: 45,
  stock_days: 20,
  discount_trend: "up",
  loan_rejections: "normal",
};

function call(patch: Partial<CallForReport> = {}): CallForReport {
  return {
    derivedStatus: "completed",
    outcome: "completed",
    weekStart: "2026-10-26",
    qaState: "auto_ok",
    answeredCount: 5,
    callbackTimeText: null,
    transcript: null,
    extracted: {
      enquiries_trend: { raw: "up", value: "up", confidence: 0.92, valid: true },
      stock_days: { raw: "do hafte", value: 14, confidence: 0.31, valid: true },
      discount_trend: { raw: "badh rahe", value: null, confidence: 0.8, valid: false },
    },
    answers,
    ...patch,
  };
}

function report(patch: Partial<ReportInput> = {}) {
  return buildCallReport({
    call: call(),
    definition: vehiclePulseV1,
    previousAnswers: { stock_days: 30 },
    flags: [],
    overrides: [],
    ...patch,
  });
}

const texts = (r: ReturnType<typeof report>) => r.changes.map((c) => c.text);

describe("buildCallReport: answers", () => {
  it("lists every question with extracted value, recorded value and its scores", () => {
    const r = report();
    expect(r.answers.map((a) => a.key)).toEqual(vehiclePulseV1.questions.map((q) => q.key));
    const enquiries = r.answers.find((a) => a.key === "enquiries_trend");
    expect(enquiries).toMatchObject({ question: "Enquiries vs last week", extracted: "up", recorded: "up" });
    expect(enquiries?.scores).toEqual([{ indicator: "Enquiries", text: "100" }]);
    // bookings_week feeds no indicator (QA only).
    expect(r.answers.find((a) => a.key === "bookings_week")?.scores).toEqual([]);
    // Stock 30 → 20 days: stock is clearing, so momentum scores 100.
    expect(r.answers.find((a) => a.key === "stock_days")?.scores).toEqual([
      { indicator: "Stock momentum", text: "100" },
    ]);
  });

  it("warns on failed validation and low confidence", () => {
    const r = report();
    expect(r.answers.find((a) => a.key === "discount_trend")?.warning).toBe("Failed validation");
    expect(r.answers.find((a) => a.key === "stock_days")?.warning).toBe("Low confidence");
    expect(r.answers.find((a) => a.key === "enquiries_trend")?.warning).toBeNull();
  });

  it("says why an unanswered question has no answer", () => {
    const { loan_rejections: _l, stock_days: _s, ...rest } = answers;
    const r = report({
      call: call({
        answers: rest,
        answeredCount: 3,
        extracted: {
          loan_rejections: { raw: null, value: null, confidence: 0.9, valid: null, status: "dont_know" },
          stock_days: { raw: null, value: null, confidence: null, valid: null, status: "not_asked" },
        },
      }),
    });
    expect(r.answers.find((a) => a.key === "loan_rejections")).toMatchObject({ recorded: null, status: "dont_know" });
    expect(r.answers.find((a) => a.key === "stock_days")?.status).toBe("not_asked");
    expect(r.answers.find((a) => a.key === "enquiries_trend")?.status).toBe("answered");
  });

  it("says stock needs a previous week when there isn't one", () => {
    const r = report({ previousAnswers: null });
    expect(r.answers.find((a) => a.key === "stock_days")?.scores[0]?.text).toBe("from week 2");
    expect(r.composite.usedWeightPct).toBe(80);
  });
});

describe("buildCallReport: what changed", () => {
  it("counts a clean completed call toward the week, with the Demand score", () => {
    const r = report();
    expect(r.outcome).toEqual({ label: "Completed", tone: "good" });
    // 25·100 + 25·50 + 20·100 + 15·(100−100) + 15·(100−50) = 6500 / 100 = 65
    expect(texts(r)).toEqual([
      "Saved as a Vehicle Dealer Pulse call for week 2026-W44.",
      "Counts toward week 2026-W44: this dealer scores 65 on the Demand index.",
    ]);
  });

  it("mentions renormalised weights when a component is missing", () => {
    expect(texts(report({ previousAnswers: null }))[1]).toMatch(/from 80% of the weights/);
  });

  it("holds flagged calls and lists the flags", () => {
    const r = report({
      call: call({ qaState: "needs_review" }),
      flags: [
        { code: "too_short", severity: "hold", questionKey: null, detail: null },
        { code: "contradiction", severity: "warn", questionKey: null, detail: null },
        { code: "invalid_answer", severity: "hold", questionKey: "discount_trend", detail: null },
      ],
    });
    expect(texts(r)).toEqual([
      "Saved as a Vehicle Dealer Pulse call for week 2026-W44.",
      "Held for review: not counted in the index until ops approves it.",
      "QA flag: Call too short to trust.",
      "QA flag: Answers contradict each other.",
      "QA flag: An answer failed validation (Discounts and offers).",
    ]);
    expect(r.changes.map((c) => c.tone)).toEqual(["neutral", "warn", "bad", "warn", "bad"]);
  });

  it("names the questions left out of the index, and why, instead of a bare flag", () => {
    const { loan_rejections: _l, ...rest } = answers;
    const r = report({
      call: call({
        answers: rest,
        answeredCount: 4,
        extracted: { loan_rejections: { raw: null, value: null, confidence: 0.9, valid: null, status: "dont_know" } },
      }),
      flags: [{ code: "missing_answers", severity: "info", questionKey: null, detail: "1 of 5 unanswered" }],
    });
    expect(texts(r)).toContain(
      "Left out of the index, no answer: Loan rejections (didn't know). The other 4 answers are used as normal.",
    );
    expect(texts(r).some((t) => t.startsWith("QA flag: Some questions"))).toBe(false);
  });

  it("explains excluded and unusable calls", () => {
    expect(texts(report({ call: call({ qaState: "excluded" }) }))[1]).toBe("Excluded from the index by ops.");
    expect(
      texts(report({ call: call({ answeredCount: 1, derivedStatus: "refused", outcome: "refused" }) }))[1],
    ).toBe("Not counted in the index: 1 of 5 questions answered (needs 2).");
  });

  it("records callbacks and wrong numbers", () => {
    const cb = call({
      derivedStatus: "callback",
      outcome: "callback",
      callbackTimeText: "kal shaam 5 baje",
      answeredCount: 0,
    });
    expect(texts(report({ call: cb })).at(-1)).toBe("Callback requested: “kal shaam 5 baje”.");
    const wrong = call({ derivedStatus: "wrong_number", outcome: "wrong_number", answeredCount: 0 });
    expect(texts(report({ call: wrong })).at(-1)).toBe("Reported as a wrong number.");
  });

  it("shows ops corrections", () => {
    const r = report({
      overrides: [{ questionKey: "stock_days", oldValue: 600, newValue: 60, reason: "misheard two months" }],
    });
    expect(texts(r).at(-1)).toBe("Ops corrected Days of stock: 600 → 60 (misheard two months).");
  });

  it("has no data for unanswered or unfinished calls", () => {
    for (const status of ["no_answer", "busy", "failed", "voicemail", "error"]) {
      const r = report({
        call: call({ derivedStatus: status, outcome: null, answeredCount: 0, answers: {} }),
      });
      expect(r.answered).toBe(false);
      expect(texts(r)).toEqual(["No data: the call wasn't answered, so nothing was recorded."]);
    }
    expect(texts(report({ call: call({ derivedStatus: "in_progress", outcome: null }) }))[0]).toMatch(
      /hasn't finished/,
    );
  });
});

describe("parseTranscript", () => {
  it("splits the agent's assistant/user lines into turns and joins wrapped lines", () => {
    expect(
      parseTranscript(
        "assistant: Namaste, main Nabz ki AI assistant hoon.\nuser: Haan boliye\nassistant: Enquiries\nbadhi ya kam?\n\nuser:",
      ),
    ).toEqual([
      { speaker: "agent", text: "Namaste, main Nabz ki AI assistant hoon." },
      { speaker: "dealer", text: "Haan boliye" },
      { speaker: "agent", text: "Enquiries\nbadhi ya kam?" },
    ]);
    expect(parseTranscript(null)).toEqual([]);
  });
});
