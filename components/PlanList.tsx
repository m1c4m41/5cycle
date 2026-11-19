"use client";
/** The student's chosen classes for a term, listed under the grid, each with a
 *  remove button (same action the catalog cards use). */
import { useActionState } from "react";
import Link from "next/link";
import { removeFromPlanAction } from "@/actions/planner";
import type { ActionState } from "@/lib/server";


export type PlanItem = {
  id: string;
  code: string;
  title: string;
  credits: string;
  meetings: string[];
  instructors: string;
};

function Row({ item }: { item: PlanItem }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(removeFromPlanAction, null);
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 text-xs leading-snug">
        <Link href={`/catalog?q=${encodeURIComponent(item.code)}`} className="font-semibold text-ink-900 hover:underline">
          {item.code}
        </Link>{" "}
        <span className="text-ink-500">· {item.credits}</span>
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

export function PlanList({ items }: { items: PlanItem[] }) {
  return (
    <section aria-label="Your chosen classes" className="border-t border-ink-100 pt-3">
      <h3 className="text-sm font-bold tracking-tight">Your chosen classes ({items.length})</h3>
      <ul className="mt-1 divide-y divide-ink-100">
        {items.map((it) => (
          <Row key={it.id} item={it} />
        ))}
      </ul>
    </section>
  );
}

