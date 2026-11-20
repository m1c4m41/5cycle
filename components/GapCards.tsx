import { findConflicts } from "@/lib/schedule";
import { hrefFor, type SP } from "@/lib/catalog-params";
import type { GapPick } from "@/lib/gapfill";
import type { Section } from "@/lib/types";
import { SectionCard, type FitInfo } from "@/components/SectionCard";
import { PreviewCard } from "@/components/PreviewCard";
import { toGridSection } from "@/lib/grid-blocks";

/** A batch of "classes that fit my schedule" cards (used by the page and by "load more"). */
export function GapCards({ picks, sp, planned }: { picks: GapPick[]; sp: SP; planned: Section[] }) {
  const plannedIds = new Set(planned.map((s) => s.id));
  const fitFor = (s: Section): FitInfo => {
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
      {picks.map((pick) => (
        <PreviewCard key={pick.section.id} section={toGridSection(pick.section)} inPlan={plannedIds.has(pick.section.id)}>
          <SectionCard
            s={pick.section}
            plannedIds={plannedIds}
            fit={fitFor(pick.section)}
            next={next}
            fromFill
            needTag={
              pick.tier === "none"
                ? undefined
                : {
                    tier: pick.tier,
                    label:
                      pick.tier === "ge"
                        ? "Fills a GE you need"
                        : pick.tier === "major"
                          ? "Fills a major requirement"
                          : "Fills a minor requirement",
                  }
            }
            reasons={pick.reasons}
          />
        </PreviewCard>
      ))}
    </>
  );
}
