import type { AnswerStatus } from "../domain/constants";
import { weekLabel } from "../domain/week";
import { type Answers, type DealerScore, scoreDealer } from "../index/score";
import { indexQuestionKeys } from "../surveys/helpers";
import { ANSWER_STATUS_LABEL, answerStatus } from "./answer-status";
import type { SurveyDefinition } from "../surveys/schema";

/**
 * Builds the "Data" pop-up for one call: what the dealer answered, how each answer was scored, and
 * what the call changed in the database. Pure: it only reads the stored call and its context, so it
 * shows exactly what happened, never what should have happened.
 */

/** One extracted field as stored on the call (keyed by question key, plus "outcome"/"callback_time"). */
export type StoredExtraction = {
  raw: unknown;
  value: string | number | null;
  confidence: number | null;
  valid: boolean | null;
  /** Answered, or why not (see answer-status.ts). Calls stored before reasons existed have none. */
  status?: AnswerStatus;
};

export type CallForReport = {
  derivedStatus: string;
  outcome: string | null;
  weekStart: string;
  qaState: "pending" | "auto_ok" | "needs_review" | "approved" | "excluded";
  answeredCount: number;
  callbackTimeText: string | null;
  transcript: string | null;
  extracted: Readonly<Record<string, StoredExtraction>>;
  answers: Answers;
};

export type ReportInput = {
  call: CallForReport;
  definition: SurveyDefinition;
  /** The same dealer's answers in the previous survey week, for momentum indicators. */
  previousAnswers: Answers | null;
  flags: readonly { code: string; severity: string; questionKey: string | null; detail: string | null }[];
  overrides: readonly { questionKey: string; oldValue: unknown; newValue: unknown; reason: string }[];
  /** A newer call from this dealer took this one's place in the index this week. */
  replaced?: boolean;
};

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

export type AnswerRow = {
  key: string;
  question: string;
  /** What the extractor captured, before validation and corrections. */
  extracted: string | null;
  /** The value the index uses. */
  recorded: string | null;
  /** Answered, or why not. */
  status: AnswerStatus;
  /** One entry per indicator this question feeds. */
  scores: { indicator: string; text: string }[];
  warning: string | null;
};

export type ChangeLine = { tone: Tone; text: string };

export type CallReport = {
  outcome: { label: string; tone: Tone };
  answered: boolean;
  answers: AnswerRow[];
  composite: {
    label: string;
    value: number | null;
    usedWeightPct: number;
    components: { label: string; weightPct: number; contribution: number; inverted: boolean }[];
  };
  changes: ChangeLine[];
  transcript: { speaker: "agent" | "dealer"; text: string }[];
};

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  completed: { label: "Completed", tone: "good" },
  partial: { label: "Partial", tone: "warn" },
  refused: { label: "Refused", tone: "bad" },
  callback: { label: "Callback requested", tone: "accent" },
  wrong_number: { label: "Wrong number", tone: "bad" },
  no_answer: { label: "No answer", tone: "neutral" },
  busy: { label: "Busy", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
  voicemail: { label: "Voicemail", tone: "neutral" },
  error: { label: "Error", tone: "bad" },
  queued: { label: "Queued", tone: "neutral" },
  in_progress: { label: "In progress", tone: "accent" },
};

/** Statuses where the dealer never talked to the agent, so the call carries no data. */
export const NOT_ANSWERED: ReadonlySet<string> = new Set(["no_answer", "busy", "failed", "voicemail", "error"]);
/** Statuses of a call that hasn't ended yet. */
export const NOT_FINISHED: ReadonlySet<string> = new Set(["queued", "in_progress"]);

/**
 * Who ended the call, from the call's telephony data. Seen on our calls: "Callee" (the dealer hung up),
 * "Plivo" with `end_call_tool` (the agent ended it) or `inactivity_timeout` (silence), "Carrier"
 * (the network, e.g. a rejected call).
 */
export function hangupLabel(by: string | null, reason: string | null): string | null {
  if (!by && !reason) return null;
  if (by === "Callee") return "Dealer";
  if (reason === "end_call_tool") return "Agent";
  if (reason === "inactivity_timeout") return "Agent, after silence";
  if (by === "Carrier") return reason ? `Network: ${reason.toLowerCase()}` : "Network";
  return [by, reason].filter(Boolean).join(": ");
}

/** How a call's status reads in ops (label and pill tone). */
export function statusLabel(derivedStatus: string): { label: string; tone: Tone } {
  return OUTCOME[derivedStatus] ?? { label: derivedStatus.replace(/_/g, " "), tone: "neutral" };
}

const FLAG_TEXT: Record<string, string> = {
  too_short: "Call too short to trust",
  invalid_answer: "An answer failed validation",
  out_of_range: "A number was outside the allowed range",
  low_confidence: "The extractor wasn't confident about an answer",
  false_completed: "Marked completed but the dealer never spoke",
  missing_answers: "Some questions weren't answered",
  contradiction: "Answers contradict each other",
  straightlining: "Every answer was the neutral one",
  bookings_mismatch: "Bookings trend disagrees with last week's count",
  stock_jump: "Days of stock changed sharply from last week",
  extraction_missing: "The agent returned no answers for this conversation",
  reextracted: "Answers read from the transcript",
};

const display = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
};

const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function parseTranscript(text: string | null | undefined): CallReport["transcript"] {
  if (!text) return [];
  const turns: CallReport["transcript"] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^(assistant|agent|bot|user|dealer|customer)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const who = m[1]!.toLowerCase();
      turns.push({
        speaker: ["assistant", "agent", "bot"].includes(who) ? "agent" : "dealer",
        text: m[2] ?? "",
      });
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.text += `\n${line}`;
    }
  }
  return turns.filter((t) => t.text.length > 0);
}

function scoreText(score: DealerScore, indicatorKey: string): string {
  const s = score.indicators.find((i) => i.key === indicatorKey);
  if (!s) return "—";
  if (s.score !== null) return fmtScore(s.score);
  return s.missing === "needs_previous_week" ? "from week 2" : "—";
}

export function buildCallReport(input: ReportInput): CallReport {
  const { call, definition } = input;
  const outcome = statusLabel(call.derivedStatus);
  const answered = !NOT_ANSWERED.has(call.derivedStatus) && !NOT_FINISHED.has(call.derivedStatus);

  const score = scoreDealer(definition, call.answers, input.previousAnswers);
  const indicatorLabel = new Map(definition.indicators.map((i) => [i.key, i.label.en]));

  const answers: AnswerRow[] = definition.questions.map((q) => {
    const ex = call.extracted[q.key];
    const feeding = definition.indicators.filter((i) => i.rule.question === q.key);
    let warning: string | null = null;
    if (ex?.valid === false) warning = "Failed validation";
    else if (ex && ex.confidence !== null && ex.confidence < definition.qa.minConfidence)
      warning = "Low confidence";
    return {
      key: q.key,
      question: q.label.en,
      extracted: display(ex?.raw ?? ex?.value),
      recorded: display(call.answers[q.key]),
      status: answerStatus(call.answers, call.extracted, q.key),
      scores: feeding.map((i) => ({ indicator: i.label.en, text: scoreText(score, i.key) })),
      warning,
    };
  });

  const composite = {
    label: definition.composite.label.en,
    value: score.composite.value,
    usedWeightPct: score.composite.usedWeightPct,
    components: score.composite.components.map((c) => ({
      label: indicatorLabel.get(c.indicator) ?? c.indicator,
      weightPct: c.weightPct,
      contribution: c.contribution,
      inverted: c.invert,
    })),
  };

  const changes: ChangeLine[] = [];
  const week = weekLabel(call.weekStart);

  if (NOT_FINISHED.has(call.derivedStatus)) {
    changes.push({ tone: "neutral", text: "The call hasn't finished yet. Its data arrives when it ends." });
  } else if (!answered) {
    changes.push({ tone: "neutral", text: "No data: the call wasn't answered, so nothing was recorded." });
  } else {
    changes.push({ tone: "neutral", text: `Saved as a ${definition.title.en} call for week ${week}.` });

    const indexCount = indexQuestionKeys(definition).length;
    if (call.qaState === "excluded") {
      changes.push({ tone: "bad", text: "Excluded from the index by ops." });
    } else if (input.replaced) {
      changes.push({
        tone: "neutral",
        text: `Replaced: this dealer was called again in week ${week}, and the newer answers count instead.`,
      });
    } else if (call.answeredCount < definition.qa.minAnsweredForUsable) {
      changes.push({
        tone: "neutral",
        text: `Not counted in the index: ${call.answeredCount} of ${indexCount} questions answered (needs ${definition.qa.minAnsweredForUsable}).`,
      });
    } else if (call.qaState === "needs_review") {
      changes.push({
        tone: "warn",
        text: "Held for review: not counted in the index until ops approves it.",
      });
    } else if (call.qaState === "pending") {
      changes.push({ tone: "neutral", text: "Waiting for automatic checks before it counts in the index." });
    } else if (score.composite.value === null) {
      changes.push({
        tone: "neutral",
        text: `Counts toward week ${week}, but has too few answers to score on the ${composite.label}.`,
      });
    } else {
      changes.push({
        tone: "good",
        text: `Counts toward week ${week}: this dealer scores ${fmtScore(score.composite.value)} on the ${composite.label}${
          composite.usedWeightPct < 100 ? ` (from ${composite.usedWeightPct}% of the weights)` : ""
        }.`,
      });
    }

    const indexKeys = indexQuestionKeys(definition);
    for (const f of input.flags) {
      if (f.code === "missing_answers") {
        // Said from the stored statuses rather than the flag text: which questions, and why.
        const missing = answers
          .filter((a) => indexKeys.includes(a.key) && a.status !== "answered")
          .map((a) => `${a.question} (${ANSWER_STATUS_LABEL[a.status].toLowerCase()})`);
        const used = indexCount - missing.length;
        changes.push({
          tone: "neutral",
          text: `Left out of the index, no answer: ${missing.join(", ")}. The other ${used} ${used === 1 ? "answer is" : "answers are"} used as normal.`,
        });
        continue;
      }
      const base = FLAG_TEXT[f.code] ?? f.code.replace(/_/g, " ");
      const question = f.questionKey
        ? definition.questions.find((q) => q.key === f.questionKey)?.label.en
        : null;
      changes.push({
        tone:
          f.severity === "hold" || f.severity === "exclude"
            ? "bad"
            : f.severity === "warn"
              ? "warn"
              : "neutral",
        text: `QA flag: ${base}${question ? ` (${question})` : ""}${f.detail ? `: ${f.detail}` : ""}.`,
      });
    }
  }

  if (call.outcome === "callback") {
    changes.push({
      tone: "accent",
      text: call.callbackTimeText
        ? `Callback requested: “${call.callbackTimeText}”.`
        : "Callback requested (no time given).",
    });
  }
  if (call.outcome === "wrong_number") {
    changes.push({ tone: "warn", text: "Reported as a wrong number." });
  }

  for (const o of input.overrides) {
    const question = definition.questions.find((q) => q.key === o.questionKey)?.label.en ?? o.questionKey;
    changes.push({
      tone: "accent",
      text: `Ops corrected ${question}: ${display(o.oldValue) ?? "empty"} → ${display(o.newValue) ?? "not answered"} (${o.reason}).`,
    });
  }

  return { outcome, answered, answers, composite, changes, transcript: parseTranscript(call.transcript) };
}
