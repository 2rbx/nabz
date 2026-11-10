import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import {
  buttonClass,
  linkClass,
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
import { db } from "@/lib/db/client";
import { setStatusLabel } from "@/lib/calls/set-status";
import { listSets, SETS_PAGE_SIZE, setDetail } from "@/lib/db/queries/sets";
import { formatCost, formatIstDateTime, formatWeekShort } from "@/lib/format";
import { SetView } from "./set-view";

export const metadata: Metadata = { title: "Sets" };

type SearchParams = PageProps<"/ops/calls/sets">["searchParams"];

export default function SetsPage({ searchParams }: PageProps<"/ops/calls/sets">) {
  return (
    <>
      <PageHeader title="Sets">Each time a batch is run, its calls together are a set.</PageHeader>
      <Suspense fallback={<LoadingCards rows={8} />}>
        <SetsBody searchParams={searchParams} />
      </Suspense>
    </>
  );
}

/** The list of sets, or one set when the URL has ?set=<id>. */
async function SetsBody({ searchParams }: { searchParams: SearchParams }) {
  await io();
  const params = await searchParams;
  if (typeof params.set !== "string") return <SetsTable params={params} />;
  const detail = await setDetail(db(), params.set);
  return (
    <div className="grid gap-3">
      <Link href="/ops/calls/sets" className={`${linkClass} text-sm`}>
        ← All sets
      </Link>
      {detail ? (
        <SetView key={params.set} id={params.set} detail={detail} />
      ) : (
        <Panel className="py-14 text-center text-sm text-faint">
          This set doesn&apos;t exist, or the link is out of date.
        </Panel>
      )}
    </div>
  );
}

async function SetsTable({ params }: { params: Awaited<SearchParams> }) {
  const n = Number(params.page);
  const page = Number.isInteger(n) && n >= 1 ? n : 1;
  const { rows, total } = await listSets(db(), { page });
  const pages = Math.max(1, Math.ceil(total / SETS_PAGE_SIZE));
  const query = (p: number) => (p > 1 ? { page: String(p) } : {});

  return (
    <Panel flush>
      {rows.length === 0 ? (
        <p className="px-5 py-14 text-center text-sm text-faint">
          No sets yet. Run `pnpm voice:seed` to fill the demo with synthetic calls.
        </p>
      ) : (
        <TableScroll>
          <table className={`${tableClass} min-w-[760px]`}>
            <thead>
              <tr className={theadRowClass}>
                <th className={thClass}>Batch</th>
                <th className={thClass}>Started</th>
                <th className={thClass}>Status</th>
                <th className={`${thClass} text-right`}>Calls done</th>
                <th className={`${thClass} text-right`}>Answered</th>
                <th className={`${thClass} text-right`}>Cost</th>
                <th className={`${thClass} text-right`}>Set</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const status = setStatusLabel(r.status);
                return (
                  <tr key={r.id} className={trClass}>
                    <td className={tdClass}>
                      <div className="font-medium">{r.batchName ?? "No batch"}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-faint">
                        <span>{formatWeekShort(r.weekStart)}</span>
                      </div>
                    </td>
                    <td className={`${tdClass} num text-xs text-muted`}>{formatIstDateTime(r.at)}</td>
                    <td className={tdClass}>
                      <Pill tone={status.tone} dot>
                        {status.label}
                      </Pill>
                    </td>
                    <td className={`${tdClass} num text-right text-xs`}>
                      {r.done}/{r.total}
                    </td>
                    <td className={`${tdClass} num text-right text-xs`}>{r.answered}</td>
                    <td className={`${tdClass} num text-right text-xs`}>{formatCost(r.costCents).inr}</td>
                    <td className={`${tdClass} text-right`}>
                      <Link
                        href={{ pathname: "/ops/calls/sets", query: { set: r.id } }}
                        className={buttonClass({ variant: "secondary", size: "sm" })}
                      >
                        Open
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
            Page <span className="num">{page}</span> of <span className="num">{pages}</span> ·{" "}
            <span className="num">{total.toLocaleString("en-IN")}</span> sets
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={{ pathname: "/ops/calls/sets", query: query(page - 1) }} className={buttonClass({ variant: "secondary", size: "sm" })}>
                Previous
              </Link>
            )}
            {page < pages && (
              <Link href={{ pathname: "/ops/calls/sets", query: query(page + 1) }} className={buttonClass({ variant: "secondary", size: "sm" })}>
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
