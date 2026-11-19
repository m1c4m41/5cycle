import { findConflicts } from "@/lib/schedule";
import { fulfillmentFor } from "@/lib/requirements";
import { hrefFor, type SP } from "@/lib/catalog-params";
import type { RequirementSet, Section } from "@/lib/types";
import { SectionCard, type FitInfo } from "@/components/SectionCard";
import { PreviewCard } from "@/components/PreviewCard";
import { toGridSection } from "@/lib/grid-blocks";

/** A batch of catalog result cards (used by the page and by "load more"). */
export function SectionCards({
  rows,
  sp,
  signedIn,
  planned,
  userSets,
}: {
  rows: Section[];
  sp: SP;
  signedIn: boolean;
  planned: Section[];
  userSets: RequirementSet[];
}) {
  const plannedIds = new Set(planned.map((s) => s.id));
  const fitFor = (s: Section): FitInfo | undefined => {
    if (!signedIn) return undefined;
    if (plannedIds.has(s.id)) return { state: "planned" };
    if (planned.length === 0) return { state: "empty" };
    const clashes = findConflicts([...planned, s]).filter((c) => c.a.id === s.id || c.b.id === s.id);
    return clashes.length
      ? { state: "conflict", n: planned.length, with: clashes.map((c) => (c.a.id === s.id ? c.b : c.a).code_string) }
      : { state: "fits", n: planned.length };
  };
  const next = hrefFor(sp, {});
  return (
    <>
      {rows.map((s) => (
        <PreviewCard key={s.id} section={toGridSection(s)} inPlan={plannedIds.has(s.id)} enabled={signedIn}>
          <SectionCard
            s={s}
            plannedIds={plannedIds}
            fit={fitFor(s)}
            next={next}
            reasons={
              userSets.length ? fulfillmentFor(s, userSets).map((f) => `${f.setName}: ${f.groupName}`) : undefined
            }
          />
        </PreviewCard>
      ))}
    </>
  );
}
