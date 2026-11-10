import type { Tone } from "./report";

/** How a set's status reads in ops (label and pill tone). */
export const SET_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Calling", tone: "accent" },
  completed: { label: "Finished", tone: "good" },
  stopped: { label: "Stopped", tone: "warn" },
};

export function setStatusLabel(status: string): { label: string; tone: Tone } {
  return SET_STATUS[status] ?? { label: status, tone: "neutral" };
}

/** Why a dealer was left out of a set. */
export type ExclusionCode = "not_permitted" | "no_agent";

export const EXCLUSION_LABEL: Record<ExclusionCode, string> = {
  not_permitted: "Not allowed in testing mode",
  no_agent: "No agent for their language",
};
