"use server";

import { refresh } from "next/cache";
import { dealerNumberRefusal } from "@/lib/calling-policy";
import { db } from "@/lib/db/client";
import { createDealer, getDealer, updateDealer } from "@/lib/db/queries/dealers";
import { type FieldErrors, parseNewDealer } from "@/lib/dealers/new-dealer";
import { callingScope } from "@/lib/env";

// There are no ops accounts, so changes are attributed to "ops" as a whole.
const ACTOR = "ops";

/** The form fields, echoed back on error so nothing the operator typed is lost. */
export type DealerFormValues = Partial<Record<keyof FieldErrors, string>>;

/** The result of submitting the dealer form (add or edit). */
export type DealerFormState =
  | { status: "idle" }
  | { status: "error"; errors: FieldErrors; values: DealerFormValues }
  | { status: "saved"; name: string; savedAt: number };

const FIELDS = ["businessName", "contactName", "contactRole", "phone", "brand", "cityCode", "language", "notes"] as const;

function formValues(formData: FormData): DealerFormValues {
  const values: DealerFormValues = {};
  for (const field of FIELDS) {
    const value = formData.get(field);
    values[field] = typeof value === "string" ? value : "";
  }
  return values;
}

export async function addDealer(_prev: DealerFormState, formData: FormData): Promise<DealerFormState> {
  const values = formValues(formData);
  const parsed = parseNewDealer(values);
  if (!parsed.ok) return { status: "error", errors: parsed.errors, values };
  const refusal = dealerNumberRefusal(parsed.dealer.phoneE164, null, callingScope());
  if (refusal) return { status: "error", errors: { phone: refusal }, values };

  const result = await createDealer(db(), parsed.dealer, { actor: ACTOR });
  if (!result.ok) return { status: "error", errors: result.errors, values };

  refresh();
  return { status: "saved", name: parsed.dealer.businessName, savedAt: Date.now() };
}

/** One dealer's current details for the edit form, or null if there's no such dealer. */
export async function loadDealer(id: string): Promise<DealerFormValues | null> {
  const dealer = await getDealer(db(), id);
  if (!dealer) return null;
  return {
    businessName: dealer.businessName,
    contactName: dealer.contactName ?? "",
    contactRole: dealer.contactRole ?? "",
    phone: dealer.phoneE164,
    brand: dealer.attributes.brand ?? "",
    cityCode: dealer.cityCode,
    language: dealer.language,
    notes: dealer.notes ?? "",
  };
}

/** Saves the edit form. The dealer's id travels as a hidden field. */
export async function saveDealer(_prev: DealerFormState, formData: FormData): Promise<DealerFormState> {
  const id = formData.get("dealerId");
  const values = formValues(formData);
  if (typeof id !== "string" || !id) {
    return { status: "error", errors: { businessName: "This dealer can't be edited." }, values };
  }
  const parsed = parseNewDealer(values);
  if (!parsed.ok) return { status: "error", errors: parsed.errors, values };
  const current = await getDealer(db(), id);
  const refusal = dealerNumberRefusal(parsed.dealer.phoneE164, current?.phoneE164 ?? null, callingScope());
  if (refusal) return { status: "error", errors: { phone: refusal }, values };

  const result = await updateDealer(db(), id, parsed.dealer, { actor: ACTOR });
  if (!result.ok) return { status: "error", errors: result.errors, values };

  refresh();
  return { status: "saved", name: parsed.dealer.businessName, savedAt: Date.now() };
}
