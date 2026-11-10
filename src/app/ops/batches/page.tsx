import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { buttonClass, KeyValues, LoadingCards, PageHeader, Panel, Pill } from "@/components/ui";
import { db } from "@/lib/db/client";
import { type BatchCard, listBatches } from "@/lib/db/queries/batches";
import { callingScope } from "@/lib/env";
import { ESTIMATED_CALL_CENTS, formatCost, formatIstDay, formatWeekShort } from "@/lib/format";
import { getState } from "@/lib/reference/geo";
import { getSector, vocabLabel } from "@/lib/sectors/registry";
import { BatchEditor } from "./batch-editor";
import { RemoveBatch } from "./remove-batch";

export const metadata: Metadata = { title: "Batches" };

export default function BatchesPage() {
  return (
    <>
      <PageHeader title="Batches" action={<BatchEditor />} />
      <Suspense fallback={<LoadingCards cards={3} rows={5} />}>
        <BatchList />
      </Suspense>
    </>
  );
}

async function BatchList() {
  await io();
  // Newest first; archived ones last (listBatches' order).
  const cards = await listBatches(db(), callingScope());
  if (cards.length === 0) {
    return (
      <Panel className="py-14 text-center text-sm text-faint">
        No batches yet. Use New batch to group dealers.
      </Panel>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => (c.archivedAt ? <ArchivedCard key={c.id} card={c} /> : <Card key={c.id} card={c} />))}
    </div>
  );
}

/** "Hero 2 · TVS 1 +3" */
function summary(items: { code: string; n: number }[], label: (code: string) => string, max = 3): string {
  if (items.length === 0) return "—";
  const head = items.slice(0, max).map((i) => `${label(i.code)} ${i.n}`);
  return items.length > max ? `${head.join(" · ")} +${items.length - max}` : head.join(" · ");
}

function stateFull(code: string): string {
  try {
    return getState(code).name;
  } catch {
    return code;
  }
}

function stateName(code: string): string {
  try {
    return getState(code).shortName;
  } catch {
    return code;
  }
}

function Card({ card }: { card: BatchCard }) {
  const sector = getSector(card.sectorSlug);
  const brands = summary(card.brands, (code) => vocabLabel(sector, "brand", code));
  const wontCall = card.members - card.callable;
  const running = card.lastSet?.status === "running";
  const cost = formatCost(card.callable * ESTIMATED_CALL_CENTS);

  // Company and state tags: the single value for a company × state batch, else how many.
  const brandTag =
    card.brands.length === 1
      ? vocabLabel(sector, "brand", card.brands[0]!.code)
      : `${card.brands.length} companies`;
  const stateTag =
    card.states.length === 1 ? stateFull(card.states[0]!.code) : `${card.states.length} states`;

  const rows: [ReactNode, ReactNode][] = [["Dealers", card.members.toLocaleString("en-IN")]];
  // A mixed batch also lists what's in it.
  if (card.brands.length > 1) rows.push(["Companies", brands]);
  if (card.states.length > 1) rows.push(["States", summary(card.states, stateName)]);
  rows.push(
    [
      "Won't be called",
      wontCall === 0 ? (
        "None"
      ) : (
        <span>
          <Pill tone="warn">{wontCall}</Pill> <span className="text-muted">Not allowed in testing mode</span>
        </span>
      ),
    ],
    [
      "Last set",
      card.lastSet ? (
        <span>
          {formatWeekShort(card.lastSet.weekStart)} · {formatIstDay(card.lastSet.at)} ·{" "}
          <span className="text-muted">
            {card.lastSet.answered} of {card.lastSet.recipients} answered
          </span>
          {running && (
            <>
              {" "}
              <Pill tone="accent" dot>
                Calling · {card.lastSet.finished} of {card.lastSet.recipients} done
              </Pill>
            </>
          )}
          {card.lastSet.status === "stopped" && (
            <>
              {" "}
              <Pill>Stopped</Pill>
            </>
          )}
        </span>
      ) : (
        <span className="text-faint">Never called</span>
      ),
    ],
  );
  rows.push([
    "Est. per set",
    <span key="cost" title={`${cost.usd} at about 2 minutes a call`}>
      ≈ {cost.inr}
    </span>,
  ]);

  return (
    <Panel className="grid content-start gap-4">
      <div className="grid gap-1">
        <h3 className="min-w-0 text-base font-semibold tracking-tight break-words">{card.name}</h3>
        {card.members > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Pill>{brandTag}</Pill>
            <Pill>{stateTag}</Pill>
          </div>
        )}
        {card.notes && <p className="text-sm text-muted">{card.notes}</p>}
      </div>
      <KeyValues rows={rows} />
      <div className="flex flex-wrap justify-end gap-2 border-t border-line-soft pt-4">
        <RemoveBatch id={card.id} name={card.name} hasSets={card.setCount > 0} />
        <BatchEditor batch={{ id: card.id, name: card.name, notes: card.notes }} />
        {running && card.lastSet && (
          <Link
            href={{ pathname: "/ops/calls/sets", query: { set: card.lastSet.id } }}
            className={buttonClass({ size: "sm" })}
          >
            Open set
          </Link>
        )}
      </div>
    </Panel>
  );
}

function ArchivedCard({ card }: { card: BatchCard }) {
  return (
    <Panel className="grid content-start gap-2 opacity-80">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-sm font-semibold break-words">{card.name}</h3>
        <Pill>Archived</Pill>
      </div>
      <p className="text-xs text-muted">
        Archived {formatIstDay(card.archivedAt)} · {card.setCount} {card.setCount === 1 ? "set" : "sets"}
        {card.lastSet && ` · last ${formatWeekShort(card.lastSet.weekStart)}`}
      </p>
    </Panel>
  );
}
