"use server";

import { refresh } from "next/cache";
import { db } from "@/lib/db/client";
import { correctAnswer, reviewCall } from "@/lib/db/queries/review";

/** The result of a review action (approve / exclude, or a corrected answer); `at` tells results apart. */
export type ReviewState = { status: "idle" } | { status: "done" | "error"; message: string; at: number };

const field = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

/** Approves or excludes a call (the note is optional). */
export async function reviewCallAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  const decision = field(formData, "decision");
  const result = await reviewCall(db(), {
    callId: field(formData, "callId"),
    decision,
    note: field(formData, "note"),
    actor: "ops",
  });
  if (!result.ok) return { status: "error", message: result.error, at: Date.now() };
  refresh();
  const message = !result.changed
    ? "Nothing changed."
    : decision === "approved"
      ? "Approved: the call counts in the index."
      : "Excluded: the call won't count in the index.";
  return { status: "done", message, at: Date.now() };
}

/** Corrects one answer and re-checks the call. */
export async function correctAnswerAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  const result = await correctAnswer(db(), {
    callId: field(formData, "callId"),
    questionKey: field(formData, "questionKey"),
    value: field(formData, "value"),
    reason: field(formData, "reason"),
    actor: "ops",
  });
  if (!result.ok) return { status: "error", message: result.error, at: Date.now() };
  refresh();
  return { status: "done", message: "Answer corrected and the call re-checked.", at: Date.now() };
}
