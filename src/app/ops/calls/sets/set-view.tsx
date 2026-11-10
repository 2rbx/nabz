import Link from "next/link";
import { linkClass, Panel, Pill, TableScroll, tableClass, tdClass, theadRowClass, thClass } from "@/components/ui";
import { setStatusLabel } from "@/lib/calls/set-status";
import type { SetDetail } from "@/lib/db/queries/sets";
import { formatCost, formatIstDateTime, formatWeekShort } from "@/lib/format";

/** One set, row by row: each dealer in the batch and how their call went. */
export function SetView({ id, detail }: { id: string; detail: SetDetail }) {
  const { set, rows } = detail;
  const status = setStatusLabel(set.status);

  return (
    <Panel flush>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-4">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">{set.batchName ?? "No batch"}</h2>
            <Pill tone={status.tone} dot>
              {status.label}
            </Pill>
          </div>
          <p className="text-xs text-muted">
            {formatWeekShort(set.weekStart)} · started {formatIstDateTime(set.at)} ·{" "}
            <span className="num">
              {detail.finished} of {detail.counted}
            </span>{" "}
            done · {formatCost(detail.costCents).inr}
          </p>
          {set.stopReason && <p className="text-sm text-bad">{set.stopReason}</p>}
        </div>
        <div className="flex items-center gap-3">
          <Link href={{ pathname: "/ops/calls", query: { set: id } }} className={`${linkClass} text-sm`}>
            See these calls
          </Link>
        </div>
      </div>
      <TableScroll>
        <table className={`${tableClass} min-w-[560px]`}>
          <thead>
            <tr className={`${theadRowClass} border-t`}>
              <th className={thClass}>Dealer</th>
              <th className={thClass}>City</th>
              <th className={thClass}>Language</th>
              <th className={thClass}>Call</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const calling = r.state === "calling";
              return (
                <tr
                  key={r.recipientId}
                  aria-current={calling ? "true" : undefined}
                  className={`border-b border-line-soft transition last:border-0 ${calling ? "bg-accent-tint font-medium" : ""}`}
                >
                  <td className={tdClass}>{r.name}</td>
                  <td className={`${tdClass} text-muted`}>{r.city}</td>
                  <td className={`${tdClass} text-muted`}>{r.language}</td>
                  <td className={tdClass}>
                    {r.callId && !calling ? (
                      <Link href={{ pathname: "/ops/calls", query: { set: id, call: r.callId } }} scroll={false}>
                        <Pill tone={r.tone} dot>
                          {r.label}
                        </Pill>
                      </Link>
                    ) : (
                      <Pill tone={r.tone} dot={calling}>
                        {r.label}
                      </Pill>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
