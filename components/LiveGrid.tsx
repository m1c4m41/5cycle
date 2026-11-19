"use client";
/** The catalog's weekly grid: your plan (minus classes you've hidden) plus shaded
 *  previews of classes you've clicked in the list. Updates instantly, no reload. */
import Link from "next/link";
import { useMemo } from "react";
import { Timetable } from "@/components/Timetable";
import { PlanList, type PlanItem } from "@/components/PlanList";
import { useCatalogGrid } from "@/components/CatalogGridProvider";
import { overlappingIds, type GridSection } from "@/lib/grid-blocks";

export function LiveGrid({
  term,
  termName,
  planned,
  items,
  credits,
}: {
  term: string;
  termName: string;
  planned: GridSection[];
  items: PlanItem[];
  credits: string;
}) {
  const { previews, clearPreviews, hidden } = useCatalogGrid();

  const { sections, ghostIds, conflictIds, ghostCount } = useMemo(() => {
    const plannedIds = new Set(planned.map((s) => s.id));
    const visible = planned.filter((s) => !hidden.has(s.id));
    // A class you've since added is in the plan; no ghost for it.
    const ghosts = Object.values(previews).filter((g) => !plannedIds.has(g.id));
    const all = [...visible, ...ghosts];
    return {
      sections: all,
      ghostIds: new Set(ghosts.map((g) => g.id)),
      conflictIds: overlappingIds(all),
      ghostCount: ghosts.length,
    };
  }, [planned, previews, hidden]);

  // Tag every planned class that overlaps another visible class in the list.
  const planConflicts = useMemo(
    () => overlappingIds(planned.filter((s) => !hidden.has(s.id))),
    [planned, hidden],
  );

  return (
    <div className="card card-pad space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold tracking-tight">Your {termName} grid</h2>
        <Link href={`/planner?term=${term}`} className="link text-xs">
          Open planner →
        </Link>
      </div>

      {sections.length > 0 ? (
        <Timetable sections={sections} ghostIds={ghostIds} conflictIds={conflictIds} />
      ) : (
        <p className="text-sm leading-relaxed text-ink-500">
          Nothing on the grid yet. Click a class in the list to see where it would land — it&rsquo;s only
          added to your plan when you press Add.
        </p>
      )}

      {ghostCount > 0 && (
        <p className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-50 px-2.5 py-1.5 text-xs text-ink-600">
          <span>
            👁 {ghostCount} shaded preview{ghostCount === 1 ? "" : "s"} — not in your plan yet.
          </span>
          <button type="button" onClick={clearPreviews} className="link">
            Clear previews
          </button>
        </p>
      )}

      {items.length > 0 && (
        <>
          <p className="text-xs text-ink-500">
            {items.length} saved course{items.length === 1 ? "" : "s"} · {credits} 5C credits.
          </p>
          <PlanList items={items} conflictIds={planConflicts} />
        </>
      )}
    </div>
  );
}
