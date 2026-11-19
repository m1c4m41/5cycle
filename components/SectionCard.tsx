import Link from "next/link";
import type { Section } from "@/lib/types";
import { AFFILIATION_LABELS, SCHOOL_BY_CODE, STATUS_LABELS } from "@/lib/constants";
import { cn, formatCredits, formatMeeting, truncate } from "@/lib/util";
import { Stars } from "./Stars";
import { extractPrerequisites } from "@/lib/prereq";

export function SchoolBadge({ code, small }: { code: string; small?: boolean }) {
  const s = SCHOOL_BY_CODE[code];
  return (
    <span
      className={cn("chip", small ? "px-1.5 py-0 text-[10px]" : "")}
      style={{
        borderColor: `color-mix(in srgb, ${s?.accent ?? "var(--color-uni)"} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${s?.accent ?? "var(--color-uni)"} 8%, transparent)`,
        color: s?.accent ?? "var(--color-ink-600)",
      }}
      title={s?.name ?? code}
    >
      {s?.short ?? code}
    </span>
  );
}

export function SeatsMeter({ s }: { s: Section }) {
  const total = s.seats_total;
  const filled = s.seats_filled;
  if (!total) {
    return (
      <span className="text-xs text-ink-500" title="Seat counts not published for this listing">
        {STATUS_LABELS[s.status] ?? s.status}
      </span>
    );
  }
  const left = Math.max(0, total - filled);
  const pct = Math.min(100, Math.round((filled / total) * 100));
  return (
    <span className="inline-flex items-center gap-1.5" title={`${filled}/${total} seats filled`}>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-ink-200">
        <span
          className={cn("block h-full rounded-full", left === 0 ? "bg-red-500" : "bg-emerald-500")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={cn("text-xs tabular-nums", left === 0 ? "text-red-700" : "text-ink-600")}>
        {left === 0 ? "Full" : `${left} open`}
        <span className="hidden text-ink-400 sm:inline"> / {total}</span>
      </span>
    </span>
  );
}

/** How this section fits the signed-in student's saved plan for the term. */
export type FitInfo =
  | { state: "planned" }
  | { state: "fits"; n: number }
  | { state: "conflict"; with: string[]; n: number }
  | { state: "empty" };

/** Catalog result row — the full registrar information set, plus planner extras. */
export function SectionCard({
  s,
  plannedIds,
  reasons,
  fit,
  previewHref,
  next,
  needTag,
  fromFill,
}: {
  s: Section;
  plannedIds: Set<string>;
  reasons?: string[];
  fit?: FitInfo;
  /** Link that opens the weekly-grid preview of this section vs the plan. */
  previewHref?: string;
  /** Where a guest's "Add" should send them (catalog page with filters). */
  next?: string;
  /** Gap-filler: what this class is needed for, shown in the header. */
  needTag?: { label: string; tier: "major" | "minor" | "ge" };
  /** Shown in the gap-filler list: adds stay listed with a remove button. */
  fromFill?: boolean;
}) {
  const href = `/section/${encodeURIComponent(s.id)}`;
  const prereq = extractPrerequisites(s.description);
  return (
    <article className="card px-3 py-2">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={href} className="font-mono text-sm font-bold text-ink-900 hover:underline">
              {s.department} {String(s.course_number).padStart(3, "0")}
              {s.suffix} {s.school_short}
              <span className="text-ink-500"> · sec {String(s.section_number).padStart(2, "0")}</span>
            </Link>
            <SchoolBadge code={s.school} small />
            {s.affiliation !== s.school && (
              <span className="chip border-ink-300 bg-ink-100 text-ink-600" title={s.affiliation}>
                {AFFILIATION_LABELS[s.affiliation] ?? s.affiliation}
              </span>
            )}
            {s.half && (
              <span className="chip border-sky-300 bg-sky-50 text-sky-700">{s.half}</span>
            )}
            {needTag && (
              <span
                className={cn(
                  "chip font-semibold",
                  needTag.tier === "ge"
                    ? "border-teal-300 bg-teal-50 text-teal-800"
                    : "border-emerald-400 bg-emerald-50 text-emerald-800",
                )}
              >
                ✓ {needTag.label}
              </span>
            )}
            {s.perm_count > 0 && (
              <span
                className="chip border-violet-300 bg-violet-50 text-violet-700"
                title={`${s.perm_count} seat(s) reserved for 5C cross-registration (perm required)`}
              >
                {s.perm_count} perm {s.perm_count === 1 ? "seat" : "seats"}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0">
          <Link href={href} className="text-sm font-semibold leading-snug text-ink-800 hover:underline">
            {s.title}
          </Link>

          {s.instructors.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0 text-xs text-ink-600">
              {s.instructors.map((i) => (
                <span key={i.id} className="inline-flex items-center gap-1">
                  <Link href={`/professors/${encodeURIComponent(i.id)}`} className="hover:underline">
                    {i.name}
                  </Link>
                  <Stars
                    value={i.avg_stars}
                    title="5Cycle students — click to read the reviews"
                    href={`/professors/${encodeURIComponent(i.id)}#reviews`}
                  />
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ink-400">Staff / instructor not posted</div>
          )}
          </div>

          {prereq && (
            <p className="mt-0.5 text-xs leading-snug text-ink-700">
              <span className="font-semibold text-amber-800">Prerequisites:</span> {prereq}
            </p>
          )}

          {(s.description || s.areas.length > 0 || (reasons && reasons.length > 0)) && (
            <details className="group mt-0.5">
              <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink-500 hover:text-ink-800 [&::-webkit-details-marker]:hidden">
                <span className="inline-block text-xl leading-none transition-transform group-open:rotate-90">▸</span>
                {[
                  s.description ? "Description" : null,
                  s.areas.length > 0 ? `${s.areas.length} area${s.areas.length === 1 ? "" : "s"}` : null,
                  reasons && reasons.length > 0
                    ? `${reasons.length} requirement${reasons.length === 1 ? "" : "s"} filled`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </summary>
          {s.description && (
            <p className="mt-2 text-sm leading-relaxed text-ink-600">{s.description}</p>
          )}

          {s.areas.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {s.areas.map((a) => (
                <Link
                  key={a.code}
                  href={`/catalog?area=${encodeURIComponent(a.code)}&term=${s.term_id}`}
                  className={cn(
                    "chip hover:bg-ink-100",
                    a.kind === "ge"
                      ? "border-teal-300 bg-teal-50 text-teal-800"
                      : "border-ink-200 bg-white text-ink-500",
                  )}
                  title={`${a.description}${a.kind === "ge" ? " — general education designation" : ""}`}
                >
                  {a.code}
                  <span className="hidden font-normal text-ink-400 sm:inline">
                    {" "}
                    · {truncate(a.description, 34)}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {reasons && reasons.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1">
              {reasons.map((r) => (
                <li key={r} className="chip border-emerald-300 bg-emerald-50 text-emerald-800">
                  ✓ {r}
                </li>
              ))}
            </ul>
          )}
            </details>
          )}

        </div>

        <div className="flex w-full flex-col items-start gap-0.5 sm:w-48 sm:items-end">
          <span className="text-sm font-semibold text-ink-800">
            {formatCredits(s.credits, s.school)}
          </span>
          {s.school === "HM" && (
            <span className="-mt-1 text-[11px] text-ink-400">
              ≈ {s.credits_5c} 5C credit{s.credits_5c === 1 ? "" : "s"}
            </span>
          )}
          <SeatsMeter s={s} />
          {s.meetings.length > 0 ? (
            <ul className="space-y-0.5 text-right text-xs text-ink-600">
              {s.meetings.map((m, i) => (
                <li key={i} className="font-mono">
                  {formatMeeting(m)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-xs text-ink-400">TBA</span>
          )}
        </div>
      </div>

      <div className="mt-1.5 border-t border-ink-100 pt-1.5 [&_.btn]:px-2.5 [&_.btn]:py-1 [&_.btn]:text-xs [&_.btn-primary]:px-2.5 [&_.btn-primary]:py-1 [&_.btn-secondary]:px-2.5 [&_.btn-secondary]:py-1 [&_.btn-ghost]:px-2 [&_.btn-ghost]:py-1">
        <EnrollSlot s={s} planned={plannedIds.has(s.id)} fit={fit} previewHref={previewHref} next={next} fromFill={fromFill} />
      </div>
    </article>
  );
}

import { EnrollButton } from "./EnrollButton";

function EnrollSlot({
  s,
  planned,
  fit,
  previewHref,
  next,
  fromFill,
}: {
  s: Section;
  planned: boolean;
  fromFill?: boolean;
  fit?: FitInfo;
  previewHref?: string;
  next?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <EnrollButton sectionId={s.id} inPlan={planned} next={next} fromFill={fromFill} />
      <div className="flex flex-wrap items-center gap-2">
        {fit && fit.state !== "planned" && (
          <>
            {fit.state === "fits" && (
              <span
                className="chip border-emerald-300 bg-emerald-50 text-emerald-800"
                title={`No time overlap with your ${fit.n} saved classes this term`}
              >
                ✓ fits your plan
              </span>
            )}
            {fit.state === "conflict" && (
              <span
                className="chip border-red-300 bg-red-50 text-red-700"
                title={`Overlaps ${fit.with.join(", ")}`}
              >
                ⚠ overlaps {fit.with.slice(0, 2).join(", ")}
                {fit.with.length > 2 ? "…" : ""}
              </span>
            )}
            {fit.state === "empty" && (
              <span className="chip border-ink-200 bg-ink-50 text-ink-500">
                nothing saved this term yet
              </span>
            )}
          </>
        )}
        {previewHref && (
          <Link
            href={previewHref}
            className="btn-ghost text-xs"
            title="Show this section on the weekly grid next to your saved classes"
          >
            View on grid
          </Link>
        )}
        <Link href={`/section/${encodeURIComponent(s.id)}`} className="btn-ghost text-xs">
          Details →
        </Link>
      </div>
    </div>
  );
}
