"use client";
/** The student's chosen classes for a term, listed under the grid, each with a
 *  remove button (same action the catalog cards use). */
import { useActionState } from "react";
import Link from "next/link";
import { removeFromPlanAction } from "@/actions/planner";
import type { ActionState } from "@/lib/server";
import { useCatalogGridOptional } from "@/components/CatalogGridProvider";


export type PlanItem = {
  id: string;
  code: string;
  title: string;
  credits: string;
  meetings: string[];
  instructors: string;
};

function Row({ item, shown, conflict, onToggle }: { item: PlanItem; shown: boolean; conflict: boolean; onToggle?: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(removeFromPlanAction, null);
  return (
    <li className={`flex items-start justify-between gap-3 py-2 ${shown ? "" : "opacity-60"}`}>
      {onToggle && (
        <input
          type="checkbox"
          checked={shown}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
          title={shown ? "Showing on the grid — untick to hide it (it stays in your plan)" : "Hidden from the grid — tick to show it"}
          aria-label={`Show ${item.code} on the grid`}
        />
      )}
      <div className="min-w-0 flex-1 text-xs leading-snug">
        <Link href={`/catalog?q=${encodeURIComponent(item.code)}`} className="font-semibold text-ink-900 hover:underline">
          {item.code}
        </Link>{" "}
        <span className="text-ink-500">· {item.credits}</span>
        {conflict && (
          <span className="ml-1.5 chip border-amber-300 bg-amber-50 text-amber-800" title="Overlaps another class on your grid">
            ⚠ conflict
          </span>
        )}
        <div className="truncate text-ink-700">{item.title}</div>
        <div className="text-ink-500">
          {item.meetings.length ? item.meetings.join(" · ") : "Time TBA"}
          {item.instructors ? ` · ${item.instructors}` : ""}
        </div>
        {state?.error && <div className="font-medium text-red-700">{state.error}</div>}
      </div>
      <form action={action}>
        <input type="hidden" name="sectionId" value={item.id} />
        <button type="submit" className="btn-secondary shrink-0 text-xs" disabled={pending}>
          {pending ? "Removing…" : "Remove"}
        </button>
      </form>
    </li>
  );
}

export function PlanList({ items, conflictIds }: { items: PlanItem[]; conflictIds?: Set<string> }) {
  const grid = useCatalogGridOptional();
  const hiddenCount = items.filter((it) => grid?.hidden.has(it.id)).length;
  return (
    <section aria-label="Your chosen classes" className="border-t border-ink-100 pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold tracking-tight">Your chosen classes ({items.length})</h3>
        {grid && hiddenCount > 0 && (
          <button type="button" onClick={grid.showAll} className="link text-xs">
            Show all {items.length} on the grid
          </button>
        )}
      </div>
      {grid && (
        <p className="mt-0.5 text-[11px] text-ink-400">
          Untick a class to hide it from the grid and try a different schedule — it stays in your plan.
        </p>
      )}
      <ul className="mt-1 divide-y divide-ink-100">
        {items.map((it) => (
          <Row
            key={it.id}
            item={it}
            shown={!grid?.hidden.has(it.id)}
            conflict={!!conflictIds?.has(it.id)}
            onToggle={grid ? () => grid.toggleHidden(it.id) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

