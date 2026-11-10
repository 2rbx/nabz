import type { ReactNode } from "react";
import { KeyValues, Pill, tableClass, tdClass, theadRowClass, thClass, trClass } from "@/components/ui";
import { ANSWER_STATUS_LABEL } from "@/lib/calls/answer-status";
import { buildCallReport, hangupLabel, type Tone } from "@/lib/calls/report";
import { correctable, QA_LABEL, reviewable } from "@/lib/calls/review";
import { optionValues } from "@/lib/surveys/helpers";
import type { Question } from "@/lib/surveys/schema";
import type { CallDetail } from "@/lib/db/queries/calls";
import { weekLabel } from "@/lib/domain/week";
import { formatCost, formatDuration, formatIstDateTime } from "@/lib/format";
import { getSector, vocabLabel } from "@/lib/sectors/registry";
import { FixAnswer, type FixableQuestion } from "./fix-answer";
import { ReviewPanel } from "./review-panel";

const DOT: Record<Tone, string> = {
  neutral: "bg-faint",
  good: "bg-good-dot",
  warn: "bg-warn-dot",
  bad: "bg-bad-dot",
  accent: "bg-accent",
};

const capitalise = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/** What the Fix form needs to know about a question. */
function fixable(q: Question): FixableQuestion {
  const options =
    q.type === "choice"
      ? q.options.map((o) => ({ value: o.value, label: o.label.en }))
      : (optionValues(q)?.map((v) => ({ value: v, label: capitalise(v) })) ?? null);
  return { key: q.key, label: q.label.en, options, range: q.type === "number" ? { min: q.min, max: q.max } : null };
}

/** The contents of the "Data" pop-up: what one call gave us and what it changed. */
export function CallReport({ detail }: { detail: CallDetail }) {
  const { call, dealer, definition } = detail;
  const report = buildCallReport({
    call: {
      derivedStatus: call.derivedStatus,
      outcome: call.outcome,
      weekStart: call.weekStart,
      qaState: call.qaState,
      answeredCount: call.answeredCount,
      callbackTimeText: call.callbackTimeText,
      transcript: call.transcript,
      extracted: detail.extracted,
      answers: call.answers,
    },
    definition,
    previousAnswers: detail.previousAnswers,
    flags: detail.flags,
    overrides: detail.overrides,
    replaced: detail.replaced,
  });
  const cost = formatCost(call.costCents);
  const canReview = reviewable(call);
  const canCorrect = correctable({ ...call, hasRawExecution: call.rawExecution !== null });
  const qa = QA_LABEL[call.qaState];
  const hungUp = hangupLabel(call.hangupBy, call.hangupReason);

  const summary: [ReactNode, ReactNode][] = [
    ["When", formatIstDateTime(call.startedAt ?? call.initiatedAt)],
    ["Duration", formatDuration(call.durationS)],
    [
      "Cost",
      <span key="c" title={`${cost.usd} on the voice stack (₹ is approximate)`}>
        {cost.inr}
      </span>,
    ],
    ["Survey", `${detail.surveyTitle} · ${weekLabel(call.weekStart)}`],
  ];
  if (hungUp) summary.push(["Hung up by", hungUp]);
  if (call.extractionSource) {
    summary.push(["Answers from", call.extractionSource === "reextract" ? "Re-read from the transcript" : "the voice agent"]);
  }
  if (canReview) {
    summary.push([
      "QA",
      <span key="qa" className="inline-flex flex-wrap items-center gap-2">
        <Pill tone={detail.replaced ? "neutral" : qa.tone}>{detail.replaced ? "Replaced" : qa.label}</Pill>
        {call.qaReviewedAt && (
          <span className="text-xs text-muted">
            by {call.qaReviewedBy} · {formatIstDateTime(call.qaReviewedAt)}
            {call.qaNote ? ` · “${call.qaNote}”` : ""}
          </span>
        )}
      </span>,
    ]);
  }
  const sector = getSector(definition.sector);
  const brand = dealer.attributes.brand ? vocabLabel(sector, "brand", dealer.attributes.brand) : null;

  return (
    <div className="grid gap-6 p-6">
      {/* 1. Summary */}
      <div className="grid gap-3 pr-10">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            {dealer.businessName}
          </h2>
          <Pill tone={report.outcome.tone} dot>
            {report.outcome.label}
          </Pill>
        </div>
        <p className="text-sm text-muted">
          {[brand, detail.city, detail.state].filter(Boolean).join(" · ")}
          {dealer.contactName ? ` · ${dealer.contactName}` : ""}
        </p>
        <KeyValues rows={summary} />
      </div>

      {/* 2. Answers */}
      {report.answered && (
        <section className="grid gap-3">
          <h3 className="text-sm font-semibold">Answers</h3>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className={`${tableClass} min-w-[560px]`}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Question</th>
                  <th className={thClass}>Extracted</th>
                  <th className={thClass}>Recorded as</th>
                  <th className={`${thClass} text-right`}>Score</th>
                </tr>
              </thead>
              <tbody>
                {report.answers.map((a) => (
                  <tr key={a.key} className={trClass}>
                    <td className={tdClass}>
                      <div className="font-medium">{a.question}</div>
                      {a.scores.length > 0 && (
                        <div className="text-xs text-faint">
                          Feeds {a.scores.map((s) => s.indicator).join(", ")}
                        </div>
                      )}
                    </td>
                    <td className={`${tdClass} text-muted`}>
                      {a.extracted ?? "—"}
                      {a.warning && (
                        <div className="mt-1">
                          <Pill tone="warn">{a.warning}</Pill>
                        </div>
                      )}
                    </td>
                    <td className={`${tdClass} font-medium`}>
                      {a.recorded ?? (
                        <span className="font-normal text-faint">
                          not answered · {ANSWER_STATUS_LABEL[a.status].toLowerCase()}
                        </span>
                      )}
                      {canCorrect && (
                        <div>
                          <FixAnswer
                            callId={call.id}
                            question={fixable(definition.questions.find((q) => q.key === a.key)!)}
                            current={call.answers[a.key] === undefined ? null : String(call.answers[a.key])}
                          />
                        </div>
                      )}
                    </td>
                    <td className={`${tdClass} num text-right`}>
                      {a.scores.length === 0 ? (
                        <span className="text-faint">—</span>
                      ) : (
                        a.scores.map((s) => s.text).join(", ")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.composite.value !== null && (
            <p className="text-xs text-muted">
              {report.composite.label} ={" "}
              {report.composite.components
                .map(
                  (c) => `${c.label} ${c.contribution}${c.inverted ? " (inverted)" : ""} × ${c.weightPct}%`,
                )
                .join(" + ")}
              {report.composite.usedWeightPct < 100 ? `, divided by ${report.composite.usedWeightPct}%` : ""}{" "}
              = <span className="num font-medium text-ink">{report.composite.value.toFixed(1)}</span>.
              {report.composite.components.some((c) => c.inverted) &&
                " Inverted components count as 100 − score, because higher means weaker."}
            </p>
          )}
        </section>
      )}

      {/* 3. What changed */}
      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">What this call changed</h3>
        <ul className="grid gap-2">
          {report.changes.map((c, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className={`mt-[7px] size-1.5 shrink-0 rounded-full ${DOT[c.tone]}`} aria-hidden="true" />
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* 4. Review */}
      {canReview && (
        <section className="grid gap-3">
          <h3 className="text-sm font-semibold">Review</h3>
          <ReviewPanel callId={call.id} qaState={call.qaState} />
        </section>
      )}

      {/* 5. Transcript */}
      {report.transcript.length > 0 && (
        <details className="group rounded-xl border border-line">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-ink select-none">
            <span className="mr-2 inline-block text-faint transition group-open:rotate-90">›</span>
            Transcript
          </summary>
          <div className="grid gap-3 border-t border-line px-4 py-4">
            {report.transcript.map((t, i) => (
              <div key={i} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 text-sm">
                <span className="eyebrow pt-0.5">{t.speaker === "agent" ? "Agent" : "Dealer"}</span>
                <p className="whitespace-pre-line">{t.text}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
