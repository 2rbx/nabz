"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { DialogHeader, dialogClass } from "@/components/dialog";
import { Button } from "@/components/ui";
import { type DealerFormState, type DealerFormValues, loadDealer, saveDealer } from "./actions";
import { DealerForm } from "./dealer-form";

/**
 * The "Edit dealer" pop-up. Mounted fresh each time a row is opened (the table
 * gives it a new key), so nothing typed survives a cancel. Loads the dealer's details, including the
 * full number, only when opened; the table itself only ever has the masked number.
 */
export function EditDealer({
  dealerId,
  onDone,
}: {
  dealerId: string;
  onDone: (savedName: string | null) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<DealerFormState, FormData>(saveDealer, { status: "idle" });
  // undefined while loading; null when the dealer no longer exists.
  const [values, setValues] = useState<DealerFormValues | null | undefined>(undefined);

  // Opening the native dialog and fetching are side effects of mounting.
  useEffect(() => {
    dialogRef.current?.showModal();
    let live = true;
    void loadDealer(dealerId).then((loaded) => {
      if (live) setValues(loaded);
    });
    return () => {
      live = false;
    };
  }, [dealerId]);

  const saved = state.status === "saved";
  useEffect(() => {
    if (saved) dialogRef.current?.close();
  }, [saved]);

  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="edit-dealer-title"
      className={dialogClass("md")}
      onClick={(e) => {
        // Clicking the dimmed backdrop (the dialog element itself) closes it without saving.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      onClose={() => onDone(state.status === "saved" ? state.name : null)}
    >
      {values ? (
        <>
          <div>
            <DealerForm
              headingId="edit-dealer-title"
              title="Edit dealer"
              description="Changes are saved to the panel. Nothing is called."
              submitLabel="Save"
              action={action}
              pending={pending}
              values={values}
              errors={state.status === "error" ? state.errors : {}}
              hidden={{ dealerId }}
              onCancel={close}
            />
          </div>
        </>
      ) : (
        <div className="grid gap-5 p-6">
          <DialogHeader
            id="edit-dealer-title"
            title="Edit dealer"
            description={values === null ? "This dealer can't be edited." : "Loading…"}
            onClose={close}
          />
          {values === null && (
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={close}>
                Close
              </Button>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
