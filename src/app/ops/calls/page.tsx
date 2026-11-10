import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import {
  buttonClass,
  filterPillClass,
  LoadingCards,
  PageHeader,
  Panel,
  Pill,
  TableScroll,
  tableClass,
  tdClass,
  theadRowClass,
  thClass,
  trClass,
} from "@/components/ui";
import { NOT_ANSWERED, NOT_FINISHED, statusLabel } from "@/lib/calls/report";
import { QA_LABEL } from "@/lib/calls/review";
import { db } from "@/lib/db/client";
import {
  CALL_QA_FILTERS,
  CALLS_PAGE_SIZE,
  type CallQaFilter,
  getCallDetail,
  listCalls,
  reviewCounts,
} from "@/lib/db/queries/calls";
import { formatCost, formatDuration, formatIstDateTime } from "@/lib/format";
import { getSector, vocabLabel } from "@/lib/sectors/registry";
import { AnswerRatesCard } from "./answer-rates-card";
import { CallDialog } from "./call-dialog";
import { CallReport } from "./call-report";

export const metadata: Metadata = { title: "Calls" };

type SearchParams = PageProps<"/ops/calls">["searchParams"];
type Params = Awaited<SearchParams>;

/** The table's filters and page, as they appear in the URL. */
type View = { page: number; qa?: CallQaFilter; set?: string };

function pageFrom(value: string | string[] | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function viewFrom(params: Params): View {
  const qa = CALL_QA_FILTERS.find((f) => f === params.qa);
  const set = typeof params.set === "string" ? params.set : undefined;
  return { page: pageFrom(params.page), qa, set };
}

/** The URL query for a view (defaults left out), plus anything extra such as the open call. */
function viewQuery(view: View, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(view.page > 1 ? { page: String(view.page) } : {}),
    ...(view.qa ? { qa: view.qa } : {}),
    ...(view.set ? { set: view.set } : {}),
    ...extra,
  };
}

function viewHref(view: View): string {
  const query = new URLSearchParams(viewQuery(view)).toString();
  return query ? `/ops/calls?${query}` : "/ops/calls";
}

export default function CallsPage({ searchParams }: PageProps<"/ops/calls">) {
  return (
    <>
      <PageHeader title="Calls" />
      <Suspense fallback={<LoadingCards rows={6} />}>
        <AnswerRatesCard />
      </Suspense>
      <Suspense fallback={<LoadingCards rows={8} />}>
        <CallsTable searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={null}>
        <CallDataDialog searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function Filters({ view, needsReview }: { view: View; needsReview: number }) {
  const qaOptions: { value?: CallQaFilter; label: string }[] = [
    { label: "All" },
    { value: "needs_review", label: needsReview > 0 ? `Needs review (${needsReview})` : "Needs review" },
    { value: "excluded", label: "Excluded" },
    { value: "approved", label: "Approved" },
  ];
  return (
    <nav aria-label="Review state" className="flex flex-wrap gap-1.5 px-5 pt-5 pb-4">
      {qaOptions.map((o) => (
        <Link
          key={o.label}
          href={{ pathname: "/ops/calls", query: viewQuery({ ...view, page: 1, qa: o.value }) }}
          scroll={false}
          aria-current={view.qa === o.value ? "true" : undefined}
          className={filterPillClass(view.qa === o.value)}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

async function CallsTable({ searchParams }: { searchParams: SearchParams }) {
  await io();
  const view = viewFrom(await searchParams);
  const database = db();
  const filter = { qa: view.qa, setId: view.set };
  let { rows, total } = await listCalls(database, { page: view.page, ...filter });
  const pages = Math.max(1, Math.ceil(total / CALLS_PAGE_SIZE));
  if (view.page > pages) {
    view.page = 1;
    ({ rows, total } = await listCalls(database, { page: 1, ...filter }));
  }
  const { needsReview } = await reviewCounts(database);
  const vehicles = getSector("vehicles");

  return (
    <Panel flush>
      <Filters view={view} needsReview={needsReview} />
      {rows.length === 0 ? (
        <p className="border-t border-line px-5 py-14 text-center text-sm text-faint">
          {view.qa || view.set
            ? "No calls match these filters."
            : "No calls yet. Every call the agent makes will appear here."}
        </p>
      ) : (
        <TableScroll>
          <table className={`${tableClass} min-w-[880px]`}>
            <thead>
              <tr className={`${theadRowClass} border-t`}>
                <th className={thClass}>Dealer</th>
                <th className={thClass}>When</th>
                <th className={thClass}>Status</th>
                <th className={`${thClass} text-right`}>Answers</th>
                <th className={thClass}>QA</th>
                <th className={thClass}>Duration</th>
                <th className={`${thClass} text-right`}>Cost</th>
                <th className={`${thClass} text-right`}>Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cost = formatCost(r.costCents);
                const brand = r.attributes.brand ? vocabLabel(vehicles, "brand", r.attributes.brand) : null;
                const status = statusLabel(r.derivedStatus);
                const talked = !NOT_ANSWERED.has(r.derivedStatus) && !NOT_FINISHED.has(r.derivedStatus);
                const qa = QA_LABEL[r.qaState];
                return (
                  <tr key={r.id} className={trClass}>
                    <td className={tdClass}>
                      <div className="font-medium">{r.businessName}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-faint">
                        <span>{[brand, r.city].filter(Boolean).join(" · ")}</span>
                      </div>
                    </td>
                    <td className={`${tdClass} num text-xs text-muted`}>
                      {formatIstDateTime(r.at ?? r.initiatedAt)}
                    </td>
                    <td className={tdClass}>
                      <Pill tone={status.tone} dot>
                        {status.label}
                      </Pill>
                    </td>
                    <td className={`${tdClass} num text-right text-xs`}>
                      {talked ? `${r.answeredCount}/${r.indexQuestions}` : <span className="text-faint">—</span>}
                    </td>
                    <td className={tdClass}>
                      {!talked ? (
                        <span className="text-xs text-faint">—</span>
                      ) : r.replaced ? (
                        <Pill>Replaced</Pill>
                      ) : (
                        <Pill tone={qa.tone}>{qa.label}</Pill>
                      )}
                    </td>
                    <td className={`${tdClass} num text-xs`}>{formatDuration(r.durationS)}</td>
                    <td className={`${tdClass} num text-right text-xs`} title={`${cost.usd} on the voice stack`}>
                      {cost.inr}
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <Link
                        href={{ pathname: "/ops/calls", query: viewQuery(view, { call: r.id }) }}
                        scroll={false}
                        className={buttonClass({ variant: "secondary", size: "sm" })}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm">
          <span className="text-muted">
            Page <span className="num">{view.page}</span> of <span className="num">{pages}</span> ·{" "}
            <span className="num">{total.toLocaleString("en-IN")}</span> calls
          </span>
          <div className="flex gap-2">
            {view.page > 1 && (
              <Link
                href={{ pathname: "/ops/calls", query: viewQuery({ ...view, page: view.page - 1 }) }}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                Previous
              </Link>
            )}
            {view.page < pages && (
              <Link
                href={{ pathname: "/ops/calls", query: viewQuery({ ...view, page: view.page + 1 }) }}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** The "Data" pop-up, shown when the URL has ?call=<id>. */
async function CallDataDialog({ searchParams }: { searchParams: SearchParams }) {
  await io();
  const params = await searchParams;
  const callId = typeof params.call === "string" ? params.call : null;
  if (!callId) return null;

  const closeHref = viewHref(viewFrom(params));
  const detail = await getCallDetail(db(), callId);

  return (
    // Keyed by call so switching between calls remounts (and re-opens) the dialog.
    <CallDialog key={callId} closeHref={closeHref} title={detail ? "Call data" : "Call not found"}>
      {detail ? (
        <CallReport detail={detail} />
      ) : (
        <div className="grid gap-1 p-6 pr-14">
          <h2 className="text-lg font-semibold tracking-tight">Call not found</h2>
          <p className="text-sm text-muted">This call doesn&apos;t exist, or the link is out of date.</p>
        </div>
      )}
    </CallDialog>
  );
}
