"use client";
/** Planner status picker: saves the moment you choose (no Save button), shows
 *  Saving… / Saved / the error, and never reloads the whole page. */
import { useActionState, useEffect, useRef, useState } from "react";
import { setStatusAction } from "@/actions/planner";
import type { ActionState } from "@/lib/server";

export function StatusSelect({
  id,
  sectionId,
  status,
  options,
}: {
  id: string;
  sectionId: string;
  status: string;
  options: { value: string; label: string }[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setStatusAction, null);
  const [value, setValue] = useState(status);
  const form = useRef<HTMLFormElement>(null);

  // Follow the server's value after a refresh; roll back if the save was refused.
  useEffect(() => setValue(status), [status]);
  useEffect(() => {
    if (state && !state.ok) setValue(status);
  }, [state, status]);

  return (
    <form ref={form} action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="sectionId" value={sectionId} />
      <label className="label mb-0" htmlFor={id}>
        Status
      </label>
      <select
        id={id}
        name="status"
        value={value}
        disabled={pending}
        onChange={(e) => {
          setValue(e.target.value);
          // Wait a tick so the form reads the new value.
          setTimeout(() => form.current?.requestSubmit(), 0);
        }}
        className="input w-auto py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="min-w-14 text-xs" aria-live="polite">
        {pending ? (
          <span className="text-ink-500">Saving…</span>
        ) : state?.ok ? (
          <span className="font-medium text-emerald-700">Saved ✓</span>
        ) : state && !state.ok ? (
          <span className="font-medium text-red-700">{state.error ?? "Couldn’t save"}</span>
        ) : null}
      </span>
    </form>
  );
}
