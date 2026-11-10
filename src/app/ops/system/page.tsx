import type { Metadata } from "next";
import { io } from "next/cache";
import { type ReactNode, Suspense } from "react";
import {
  CardHeader,
  KeyValues,
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
import { dataTotals } from "@/lib/db/queries/ops";
import { maskPhone } from "@/lib/domain/phone";
import { EXTRACT_MODEL, REPLY_MODEL } from "@/lib/claude/client";
import { callingScope, voiceEnv } from "@/lib/env";
import { BUDGET_LIMITS } from "@/lib/voice/budget";
import { fileBudgetStore } from "@/lib/voice/runtime";

export const metadata: Metadata = { title: "System" };

/** A table card: header with padding, then a table running edge to edge. */
function TableCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel flush>
      <div className="px-5 pt-5 pb-4">
        <CardHeader title={title} />
      </div>
      <TableScroll>{children}</TableScroll>
    </Panel>
  );
}

export default function SystemPage() {
  return (
    <>
      <PageHeader title="System" />
      <Suspense fallback={<LoadingCards rows={7} />}>
        <SystemTables />
      </Suspense>
    </>
  );
}

async function SystemTables() {
  await io();
  const keys = voiceEnv();
  const scope = callingScope();
  const spend = fileBudgetStore().load();
  const totals = await dataTotals(db());

  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <Panel className="grid content-start gap-4">
          <CardHeader title="Voice agent" />
          <KeyValues
            roomy
            rows={[
              ["Gnani API key", keys.GNANI_API_KEY ? <Pill tone="accent">Set</Pill> : <Pill>Not set</Pill>],
              ["Claude API key", keys.CLAUDE_API_KEY ? <Pill tone="accent">Set</Pill> : <Pill>Not set</Pill>],
              [
                "Claude spend",
                <span key="c" className="num">
                  ${spend.claudeUsd.toFixed(3)} of ${BUDGET_LIMITS.claudeCapUsd}
                </span>,
              ],
              [
                "Gnani credits (estimate)",
                <span key="g" className="num">
                  {spend.gnaniCredits.toFixed(1)} of {BUDGET_LIMITS.gnaniCapCredits.toLocaleString("en-IN")}
                </span>,
              ],
              ["Mode", scope.mode === "production" ? <Pill tone="warn">Production</Pill> : <Pill tone="accent">Testing</Pill>],
              [
                "Allowed numbers",
                scope.mode === "production" ? "Any number" : scope.allowedNumbers.map(maskPhone).join(", ") || "None",
              ],
            ]}
          />
        </Panel>

        <Panel className="grid content-start gap-4">
          <CardHeader title="Data" />
          <KeyValues
            roomy
            rows={[
              ["Dealers", totals.dealers.toLocaleString("en-IN")],
              ["Batches", totals.batches.toLocaleString("en-IN")],
              ["Sets", totals.sets.toLocaleString("en-IN")],
              ["Calls", totals.calls.toLocaleString("en-IN")],
            ]}
          />
        </Panel>
      </div>

      <TableCard title="Models">
        <table className={`${tableClass} min-w-[560px]`}>
          <thead>
            <tr className={`${theadRowClass} border-t`}>
              <th className={thClass}>Job</th>
              <th className={thClass}>Model</th>
            </tr>
          </thead>
          <tbody>
            {MODELS.map(([job, model]) => (
              <tr key={job} className={trClass}>
                <td className={tdClass}>{job}</td>
                <td className={`${tdClass} num text-xs text-muted`}>{model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}

/** What the voice agent runs on. */
const MODELS: [job: string, model: string][] = [
  ["Hears the dealer (speech to text)", "Gnani Prisma · prisma-v3.0"],
  ["Speaks the questions (text to speech)", "Gnani Timbre · timbre-v2.5"],
  ["Holds the conversation", `Claude · ${REPLY_MODEL}`],
  ["Reads the answers out of the call", `Claude · ${EXTRACT_MODEL}`],
];
