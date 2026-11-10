import type { Metadata } from "next";
import { io } from "next/cache";
import { Suspense } from "react";
import { LoadingCards, PageHeader } from "@/components/ui";
import { voiceEnv } from "@/lib/env";
import { EMPTY_BUDGET } from "@/lib/voice/budget";
import { fileBudgetStore } from "@/lib/voice/runtime";
import { VoiceCall } from "./voice-call";

export const metadata: Metadata = { title: "Voice agent" };

export default function VoicePage() {
  return (
    <>
      <PageHeader title="Voice agent">
        The Nabz call agent, built on Gnani models: Prisma hears, Timbre speaks, Claude holds the conversation.
      </PageHeader>
      <Suspense fallback={<LoadingCards cards={2} rows={4} />}>
        <Call />
      </Suspense>
    </>
  );
}

async function Call() {
  await io();
  const keys = voiceEnv();
  if (!keys.GNANI_API_KEY || !keys.CLAUDE_API_KEY) {
    return <p className="text-sm text-muted">Set GNANI_API_KEY and CLAUDE_API_KEY in .env to use the voice agent.</p>;
  }
  const spend = fileBudgetStore().load();
  return (
    <VoiceCall
      initialSpend={{
        claudeUsd: spend.claudeUsd ?? EMPTY_BUDGET.claudeUsd,
        gnaniCredits: spend.gnaniCredits ?? EMPTY_BUDGET.gnaniCredits,
        claudeCalls: spend.claudeCalls ?? EMPTY_BUDGET.claudeCalls,
      }}
    />
  );
}
