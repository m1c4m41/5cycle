"use client";
/**
 * "Studying abroad" control for the planner. Ticking the box reveals a term
 * dropdown (fall, spring or summer — published or not); saving marks that term
 * as study abroad. Marked terms show as chips with a ✕ to undo.
 */
import { useState } from "react";
import { setAbroadAction } from "@/actions/requirements";

export function AbroadPicker({
  options,
  marked,
  defaultTerm,
  next,
}: {
  options: { id: string; label: string }[];
  marked: { id: string; label: string }[];
  defaultTerm: string;
  next: string;
}) {
  const [open, setOpen] = useState(marked.length > 0);
  const free = options.filter((o) => !marked.some((m) => m.id === o.id));
  const initial = free.some((o) => o.id === defaultTerm) ? defaultTerm : (free[0]?.id ?? "");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 hover:bg-ink-50">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => setOpen(e.target.checked)}
          className="h-4 w-4 accent-brand-600"
        />
        🌍 studying abroad
      </label>

      {open && (
        <>
          <form action={setAbroadAction} className="flex items-center gap-1.5">
            <input type="hidden" name="abroad" value="1" />
            <input type="hidden" name="next" value={next} />
            <select
              name="termId"
              defaultValue={initial}
              className="input w-auto"
              aria-label="Which term are you studying abroad?"
            >
              {free.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary" disabled={free.length === 0}>
              Mark term
            </button>
          </form>
          {marked.map((m) => (
            <form key={m.id} action={setAbroadAction} className="inline">
              <input type="hidden" name="termId" value={m.id} />
              <input type="hidden" name="next" value={next} />
              <span className="chip border-sky-300 bg-sky-50 text-sky-800">
                🌍 {m.label}
                <button type="submit" className="ml-1 text-sky-500 hover:text-red-600" title={`Unmark ${m.label}`} aria-label={`Unmark ${m.label}`}>
                  ✕
                </button>
              </span>
            </form>
          ))}
        </>
      )}
    </div>
  );
}
