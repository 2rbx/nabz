"use server";

import { refresh } from "next/cache";
import { type BatchFieldErrors, parseBatchForm } from "@/lib/batches/form";
import { db } from "@/lib/db/client";
import {
  batchMemberIds,
  batchPicker,
  type PickerDealer,
  type RemoveBatchResult,
  removeBatch,
  saveBatch,
} from "@/lib/db/queries/batches";
import { isUuid } from "@/lib/domain/uuid";
import { callingScope } from "@/lib/env";

// There are no ops accounts, so changes are attributed to "ops" as a whole.
const ACTOR = "ops";

const asId = (v: unknown): string | null => (isUuid(v) ? v : null);

/** The checklist for the batch form: every dealer, and (when editing) who's in the batch. */
export async function getBatchPicker(batchId: unknown): Promise<{ dealers: PickerDealer[]; memberIds: string[] }> {
  const database = db();
  const dealers = await batchPicker(database, callingScope());
  const id = asId(batchId);
  const memberIds = id ? await batchMemberIds(database, id) : [];
  return { dealers, memberIds };
}

export type SaveBatchState =
  | { status: "idle" }
  | { status: "error"; errors: BatchFieldErrors }
  | { status: "saved"; name: string; created: boolean; savedAt: number };

export async function saveBatchAction(_prev: SaveBatchState, formData: FormData): Promise<SaveBatchState> {
  const batchId = asId(formData.get("batchId"));
  const parsed = parseBatchForm({
    name: formData.get("name") ?? "",
    notes: formData.get("notes") ?? "",
    memberIds: formData.getAll("memberIds"),
  });
  if (!parsed.ok) return { status: "error", errors: parsed.errors };

  const result = await saveBatch(db(), parsed.batch, { actor: ACTOR, batchId });
  if (!result.ok) return { status: "error", errors: result.errors };

  refresh();
  return { status: "saved", name: parsed.batch.name, created: !batchId, savedAt: Date.now() };
}

export async function removeBatchAction(batchId: unknown): Promise<RemoveBatchResult> {
  const id = asId(batchId);
  if (!id) return { ok: false, error: "This batch no longer exists." };
  const result = await removeBatch(db(), id, { actor: ACTOR });
  if (result.ok) refresh();
  return result;
}
