"use client";
/** "Notify me when a spot opens" — shown on full, planned, no-perm classes. */
import { useActionState, useRef } from "react";
import { toggleSeatAlertAction } from "@/actions/planner";
import type { ActionState } from "@/lib/server";

export function SeatAlertToggle({ sectionId, on }: { sectionId: string; on: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(toggleSeatAlertAction, null);
  const form = useRef<HTMLFormElement>(null);
  const checked = state?.ok ? state.notice?.startsWith("We") === true : on;
  return (
    <form ref={form} action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="on" value={checked ? "0" : "1"} />
      <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-sky-900">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={() => form.current?.requestSubmit()}
          className="h-3.5 w-3.5 accent-brand-600"
        />
        🔔 Notify me when a spot opens
      </label>
      {state && !state.ok && state.error && <span className="text-xs text-red-700">{state.error}</span>}
    </form>
  );
}
