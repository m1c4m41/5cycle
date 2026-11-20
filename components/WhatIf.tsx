/**
 * "What if": progress on every requirement set as the checklist stands (solid) and
 * as it would be if the student takes the 📌 classes they've only pinned (shaded).
 * Each set expands to every requirement, showing which planned classes fill it.
 */
import type { ReactNode } from "react";
import type { GroupProgress, Section, SetProgress } from "@/lib/types";
import { cn } from "@/lib/util";

const KIND_LABEL: Record<string, string> = { ge: "GE", major: "Major", minor: "Minor", track: "Pre-health" };

type RowState = "done" | "gain" | "partial" | "open";

const EPS = 1e-9;
const fmt = (n: number) => String(Number(n.toFixed(2)));
/** What a box asks for, in 5C credits (a course counts as 1 credit unless the box states credits). */
const needCr = (g: GroupProgress) => g.neededCredits ?? (g.neededCourses > 0 ? g.neededCourses : 0);
/** Filled by credits, not by headcount: a half-credit class only fills half a course. Optional boxes count once actually filled. */
const metCr = (g: GroupProgress | undefined) => {
  if (!g) return false;
  const need = needCr(g);
  if (g.group.required === 0) return need > 0 && g.effectiveCredits >= need - EPS && g.satisfied;
  return g.satisfied && (need === 0 || g.effectiveCredits >= need - EPS);
};
const requiredMet = (groups: GroupProgress[]) => groups.filter((g) => g.group.required !== 0 && metCr(g)).length;

function stateOf(base: GroupProgress | undefined, wi: GroupProgress): RowState {
  if (metCr(base)) return "done";
  if (metCr(wi)) return "gain";
  if (wi.effectiveCredits > 0) return "partial";
  return "open";
}

const label = (s: Section) => (s.manual ? s.title : s.code_string.split(" · ")[0].replace(/\s+sec .*$/i, ""));

export function WhatIf({
  base,
  whatIf,
  picker,
  hasPlanned,
}: {
  base: SetProgress[];
  whatIf: SetProgress[];
  picker?: ReactNode;
  /** Are there classes counted only in the what-if (not yet taken/registered)? */
  hasPlanned: boolean;
}) {
  const baseById = new Map(base.map((p) => [p.set.id, p]));
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-ink-500">
        <span className="mr-1 inline-block h-2 w-4 rounded-sm bg-brand-600 align-middle" /> in your checklist now
        <span className="mx-1 ml-3 inline-block h-2 w-4 rounded-sm bg-brand-300 align-middle" /> adds if you take your
        pinned 📌 classes. Use 🎯 next to a class in your Course schedule to choose what it counts for.
      </p>
      <p className="text-xs leading-relaxed text-ink-500">
        Counted in 5C credits, not class headcount: a half-credit class fills half a course, and an HMC 3-credit class
        counts as 1.
      </p>
      {picker}
      <ul className="space-y-3">
        {whatIf.map((p) => {
          const b = baseById.get(p.set.id);
          // Counted in credits, so a half-credit class only fills half a course.
          const baseSat = b ? requiredMet(b.groups) : 0;
          const wiSat = requiredMet(p.groups);
          const pctOf = (n: number) => (p.totalGroups ? Math.round((n / p.totalGroups) * 100) : 100);
          const basePct = pctOf(baseSat);
          const wiPct = Math.max(pctOf(wiSat), basePct);
          const gained = wiSat - baseSat;
          const baseGroups = new Map((b?.groups ?? []).map((g) => [g.group.id, g]));
          return (
            <li key={p.set.id}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">
                  {p.set.name} <span className="text-xs uppercase text-ink-400">{KIND_LABEL[p.set.kind] ?? p.set.kind}</span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums text-ink-600">
                  {baseSat}/{p.totalGroups}
                  {gained > 0 && <span className="font-semibold text-brand-700"> → {wiSat}/{p.totalGroups}</span>}
                  {" · "}
                  {basePct}%{wiPct > basePct && <span className="font-semibold text-brand-700"> → {wiPct}%</span>}
                </span>
              </div>
              <div className="relative mt-1 h-2 overflow-hidden rounded-full bg-ink-200">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-brand-300"
                  style={{
                    width: `${wiPct}%`,
                    backgroundImage:
                      "repeating-linear-gradient(135deg, rgba(255,255,255,.45) 0 4px, transparent 4px 8px)",
                  }}
                />
                <div className="absolute inset-y-0 left-0 rounded-full bg-brand-600" style={{ width: `${basePct}%` }} />
              </div>
              <details className="group mt-1">
                <summary className="cursor-pointer select-none text-xs font-semibold text-ink-600 hover:text-brand-700">
                  <span className="group-open:hidden">Show every requirement ({p.totalGroups})</span>
                  <span className="hidden group-open:inline">Hide requirements</span>
                </summary>
                <ul className="mt-1.5 space-y-1 rounded-lg border border-ink-100 bg-ink-50/50 p-2">
                  {p.groups.map((gp) => {
                    const bg = baseGroups.get(gp.group.id);
                    const st = stateOf(bg, gp);
                    const baseIds = new Set((bg?.matched ?? []).map((s) => s.id));
                    const adds = gp.matched.filter((s) => !baseIds.has(s.id));
                    const need = needCr(gp) > 0 ? needCr(gp) : null;
                    const baseCr = bg?.effectiveCredits ?? 0;
                    return (
                      <li key={gp.group.id} className="flex items-start gap-2 text-xs leading-snug">
                        <span
                          aria-hidden
                          className={cn(
                            "mt-px w-4 shrink-0 text-center font-bold",
                            st === "done" && "text-emerald-600",
                            st === "gain" && "text-brand-600",
                            st === "partial" && "text-amber-600",
                            st === "open" && "text-ink-300",
                          )}
                        >
                          {st === "done" ? "✓" : st === "gain" ? "＋" : st === "partial" ? "◐" : "○"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn(st === "done" ? "text-ink-700" : st === "open" ? "text-ink-500" : "font-semibold text-ink-900")}>
                            {gp.group.name}
                            {gp.group.required === 0 && <span className="ml-1 font-normal text-ink-400">(optional)</span>}
                          </span>
                          {need !== null && (
                            <span className="ml-1 tabular-nums text-ink-400">
                              {fmt(baseCr)}
                              {adds.length > 0 && st !== "done" ? ` → ${fmt(gp.effectiveCredits)}` : ""}/{fmt(need)} cr
                            </span>
                          )}
                          {adds.length > 0 && st !== "done" && (
                            <span className="block text-brand-700">
                              {st === "gain" ? "completed by " : "toward: "}
                              {adds.map(label).join(", ")}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
      {!hasPlanned && (
        <p className="text-xs text-ink-500">
          No pinned classes yet, so the shaded part is empty. Add a class you want to take (📌 Want to take, in a term
          of your Course schedule) to see what it would change. Once you add a real section from the catalog, it moves
          into your checklist.
        </p>
      )}
    </div>
  );
}
