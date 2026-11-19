/**
 * Requirement checklist — Campus GE, Major, Minor.
 *
 * All requirement definitions and their satisfaction math come from
 * lib/requirements.ts; nothing on this page is hand-authored. Slot assignment
 * is a maximum bipartite matching (Kuhn's algorithm) with two overrides:
 * checked boxes (advisor designations / manual courses) pin a course into a
 * group, and Educational-Objective / Breadth groups may double-dip a course
 * that already counts elsewhere in the same set.
 */
import Link from "next/link";
import {
  removeManualCourseAction,
  saveCourseCounting,
} from "@/actions/requirements";
import { GroupCheckboxes } from "@/components/GroupCheckboxes";
import { SetCard } from "@/components/SetCard";
import { OVERLAP_POLICY, overlapPolicyFor } from "@/lib/counting";
import { SCHOOLS } from "@/lib/constants";
import { currentTermId } from "@/lib/ingest";
import { preferredTerm } from "@/lib/term-pref";
import { TermRemember } from "@/components/TermRemember";
import {
  assignmentsFor,
  countingSetsFor,
  fulfillmentFor,
  groupLabel,
  isBreadthGroup,
  labItemsFor,
  labSummary,
  labLxKeys,
  listSets,
  manualCoursesFor,
  abroadTermsFor,
  manualPseudoSection,
  progressForSet,
  progressForUser,
  requirementsLoaded,
  setsForUser,
  pairUseFrom,
  type Assignment,
  type LabItem,
} from "@/lib/requirements";
import { enrolledSections, plannedTerms } from "@/lib/schedule";
import { currentUser } from "@/lib/session";
import { SchoolBadge } from "@/components/SectionCard";
import type {
  GroupProgress,
  Matcher,
  ManualCourse,
  RequirementGroup,
  RequirementSet,
  Section,
  SetProgress,
} from "@/lib/types";
import { cn, formatCredits, schoolShort, termLabel, truncate } from "@/lib/util";

/** Where each college publishes its double-counting rules. */
const POLICY_LINKS: Record<string, string> = {
  SC: "https://catalog.scrippscollege.edu/content.php?catoid=35&navoid=4452",
  PZ: "https://catalog.pitzer.edu/content.php?catoid=32&navoid=2329",
  CM: "https://catalog.claremontmckenna.edu/content.php?catoid=43&navoid=9175",
  PO: "https://pomona-preview.catalog.prod.coursedog.com/academicpolicies/degreegraduationpolicies/specialmajorsdoublemajorsminors",
};

export const dynamic = "force-dynamic";

/** Undergrad campuses only — CG is a graduate institution and has no GE set here. */
const STUDENT_SCHOOLS = SCHOOLS.filter((s) => s.code !== "CG");

const KIND_LABEL: Record<string, string> = {
  ge: "Campus general education",
  major: "Major",
  minor: "Minor",
};

type SP = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}

/** Rebuild a /requirements URL with one key changed — every control is a GET. */
function hrefFor(sp: SP, overrides: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  const merged: SP = { ...sp, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = q.toString();
  return `/requirements${s ? `?${s}` : ""}`;
}

/** Normalized 5C credits, trimmed for display. */
function cr(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** Calendar ordering for term menus (string sort puts SP after FA). */
function termKey(id: string): number {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(id);
  if (!m) return 0;
  const season = m[1] === "FA" ? 2 : m[1] === "SU" ? 1 : 0;
  return Number(m[2]) * 10 + season;
}

function levelLabel(level: string): string {
  return level === "intro" ? "Intro level" : level === "upper" ? "Upper division" : "Any level";
}

/* -------------------------------------------------------------------------- */
/* "Find a course that fits" — map a group rule onto catalog's real params    */
/* -------------------------------------------------------------------------- */

type CatalogFilter = { key: string; value: string; extra?: { key: string; value: string } };

/** First non-combinator matcher that survives translation into a catalog filter. */
function mapMatcher(m: Matcher): CatalogFilter | null {
  switch (m.type) {
    case "area":
      return m.codes.length ? { key: "area", value: m.codes[0] } : null;
    case "department":
      return {
        key: "dept",
        value: m.department,
        // Narrow to the campus the rule names, when it names exactly one.
        extra:
          m.schools?.length === 1 ? { key: "school", value: m.schools[0] } : undefined,
      };
    case "course":
      return m.codes.length ? { key: "q", value: m.codes[0] } : null;
    case "titleKeyword":
      return m.keywords.length ? { key: "q", value: m.keywords[0] } : null;
    case "and":
    case "or":
      for (const child of m.children) {
        const hit = mapMatcher(child);
        if (hit) return hit;
      }
      return null;
    // `not` is an exclusion and `any` is unconstrained — neither is a filter.
    case "not":
    case "any":
      return null;
    default:
      return null;
  }
}

function catalogHref(g: RequirementGroup, term: string): string {
  const q = new URLSearchParams();
  if (term) q.set("term", term);
  for (const rule of g.rules) {
    const hit = mapMatcher(rule.match);
    if (!hit) continue;
    q.set(hit.key, hit.value);
    if (hit.extra) q.set(hit.extra.key, hit.extra.value);
    break;
  }
  return `/catalog?${q.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Small render helpers (plain functions — this page stays one server module) */
/* -------------------------------------------------------------------------- */

/** Checkbox-look indicator: filled / indeterminate / unchecked. */
function stateGlyph(state: "full" | "half" | "empty") {
  const box = "mt-0.5 h-4 w-4 shrink-0";
  if (state === "full") {
    return (
      <svg viewBox="0 0 20 20" className={box} aria-hidden="true">
        <rect x="1.5" y="1.5" width="17" height="17" rx="4" className="fill-emerald-600 stroke-emerald-700" strokeWidth="1.4" />
        <path
          d="M5.4 10.3l3 3 6.2-6.8"
          fill="none"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-white"
        />
      </svg>
    );
  }
  if (state === "half") {
    return (
      <svg viewBox="0 0 20 20" className={box} aria-hidden="true">
        <rect
          x="1.5"
          y="1.5"
          width="17"
          height="17"
          rx="4"
          className="fill-white stroke-amber-500"
          strokeWidth="1.5"
          strokeDasharray="3 2"
        />
        <rect x="4.5" y="8.6" width="11" height="2.8" rx="1.4" className="fill-amber-500" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" className={box} aria-hidden="true">
      <rect x="1.5" y="1.5" width="17" height="17" rx="4" className="fill-white stroke-ink-300" strokeWidth="1.5" />
    </svg>
  );
}

/** Glyph for manually entered courses (abroad / transfer / create-your-own). */
function manualGlyph(s: Section): string {
  if (!s.manual) return "";
  return s.manual.kind === "abroad" ? "🌍" : s.manual.kind === "transfer" ? "📦" : s.manual.kind === "planned" ? "📌" : s.manual.kind === "summer" ? "☀️" : "✏️";
}

function courseChip(s: Section, extra: boolean) {
  const cls = cn(
    "chip font-mono",
    extra
      ? "border-ink-200 bg-ink-50 font-normal text-ink-400"
      : "border-emerald-300 bg-emerald-50 text-emerald-900",
  );
  const body = (
    <>
      {s.manual && (
        <span aria-hidden className="mr-0.5">
          {manualGlyph(s)}
        </span>
      )}
      {s.code_string}
      <span className={extra ? "text-ink-400" : "text-emerald-700"}>{cr(s.credits_5c)} cr</span>
    </>
  );
  return (
    <li key={`${extra ? "extra" : "match"}-${s.id}`}>
      {s.manual ? (
        <span
          className={cls}
          title={`${s.title} — manually entered (${s.manual.termLabel}, ${s.manual.kind}) · ${cr(s.credits_5c)} 5C credits`}
        >
          {body}
        </span>
      ) : (
        <Link
          href={`/section/${encodeURIComponent(s.id)}`}
          title={`${s.title} — ${formatCredits(s.credits, s.school)} (normalized: ${cr(s.credits_5c)} 5C credits)`}
          className={cls}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

const MAX_CHIPS = 8;

function renderGroup(gp: GroupProgress, term: string, set: RequirementSet) {
  const g = gp.group;
  const optional = g.required === 0;
  const untouched = gp.haveCourses === 0 && gp.haveCredits === 0;
  const state: "full" | "half" | "empty" = gp.satisfied && !(optional && untouched) ? "full" : gp.partial ? "half" : "empty";
  const fullCreditOnly = set.kind === "ge" || isBreadthGroup(g);

  const counts: string[] = [];
  if (g.min_courses) counts.push(`${gp.haveCourses}/${g.min_courses} course${g.min_courses === 1 ? "" : "s"}`);
  if (g.min_credits) counts.push(`${cr(gp.haveCredits)}/${cr(g.min_credits)} 5C credits`);

  const contested = !gp.satisfied && gp.excess.length > 0;

  return (
    <li
      key={g.id}
      className={cn(
        "rounded-lg border px-3 py-2.5",
        gp.satisfied
          ? "border-emerald-200 bg-emerald-50/50"
          : gp.partial
            ? "border-amber-200 bg-amber-50/50"
            : "border-ink-200 bg-white",
      )}
    >
      <div className="flex items-start gap-2">
        {stateGlyph(state)}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-ink-900">{g.name}</span>
            <span
              className={cn(
                "chip",
                gp.satisfied
                  ? "border-emerald-300 bg-white text-emerald-800"
                  : gp.partial
                    ? "border-amber-300 bg-white text-amber-800"
                    : "border-ink-200 bg-ink-50 text-ink-500",
              )}
            >
              {optional && untouched
                ? "optional — nothing yet"
                : gp.satisfied
                  ? optional
                    ? "met (optional)"
                    : "satisfied"
                  : gp.partial
                    ? "in progress"
                    : "not met"}
            </span>
            <span className="chip border-ink-200 bg-white text-ink-500">{levelLabel(g.level)}</span>
            {fullCreditOnly && (
              <span
                className="chip border-sky-200 bg-sky-50 text-sky-700"
                title="0.5-credit courses can’t tick this box — a full credit is needed at most 5C schools. Their credits still count toward your graduation total (32)."
              >
                full credit only
              </span>
            )}
            {counts.length > 0 && (
              <span className="text-xs font-semibold tabular-nums text-ink-700">
                {counts.join(" · ")}
              </span>
            )}
            {counts.length === 0 && (
              <span className="text-xs text-ink-400">no course or credit floor recorded</span>
            )}
          </div>

          {g.notes && <p className="mt-1 text-xs leading-relaxed text-ink-500">{truncate(g.notes, 260)}</p>}

          {gp.matched.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {gp.matched.slice(0, MAX_CHIPS).map((s) => courseChip(s, false))}
              {gp.matched.length > MAX_CHIPS && (
                <li className="chip border-ink-200 bg-white text-ink-500">
                  +{gp.matched.length - MAX_CHIPS} more
                </li>
              )}
            </ul>
          )}

          {gp.pinned.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap items-center gap-1">
              <li className="text-[11px] text-indigo-700">📌 counted here (checked box):</li>
              {gp.pinned.slice(0, MAX_CHIPS).map((s) => {
                const halfNoCount = s.credits_5c < 1 && fullCreditOnly;
                const chipCls = "chip border-indigo-300 bg-indigo-50 font-mono text-indigo-900";
                const chipTitle = halfNoCount
                  ? "Checked here, but a 0.5-credit course can’t tick this box — a full credit is needed. Its credits still count toward your total."
                  : s.manual
                    ? `Manually entered (${s.manual.termLabel}) — checked into this box by you or your advisor.`
                    : "Checked into this box by you or your advisor — it can also be checked in other boxes.";
                const chipBody = (
                  <>
                    {s.manual && (
                      <span aria-hidden className="mr-0.5">
                        {manualGlyph(s)}
                      </span>
                    )}
                    {s.code_string}
                    <span className="text-indigo-600">{cr(s.credits_5c)} cr</span>
                  </>
                );
                return (
                  <li key={`pin-${s.id}`} className="flex items-center gap-1">
                    {s.manual ? (
                      <span className={chipCls} title={chipTitle}>
                        {chipBody}
                      </span>
                    ) : (
                      <Link href={`/section/${encodeURIComponent(s.id)}`} className={chipCls} title={chipTitle}>
                        {chipBody}
                      </Link>
                    )}
                    {halfNoCount && (
                      <span className="chip border-amber-300 bg-amber-50 text-amber-800" title={chipTitle}>
                        won’t tick this box
                      </span>
                    )}
                  </li>
                );
              })}
              {gp.pinned.length > MAX_CHIPS && (
                <li className="chip border-ink-200 bg-white text-ink-500">
                  +{gp.pinned.length - MAX_CHIPS} more checked
                </li>
              )}
            </ul>
          )}

          {gp.excess.length > 0 && (
            <ul className="mt-1 flex flex-wrap items-center gap-1">
              <li className="text-[11px] text-ink-400">extra, already counted elsewhere:</li>
              {gp.excess.slice(0, MAX_CHIPS).map((s) => courseChip(s, true))}
              {gp.excess.length > MAX_CHIPS && (
                <li className="chip border-ink-200 bg-white text-ink-400">
                  +{gp.excess.length - MAX_CHIPS} more
                </li>
              )}
            </ul>
          )}

          {contested && (
            <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-relaxed text-amber-900">
              {gp.excess.length} course{gp.excess.length === 1 ? "" : "s"} in your plan also
              match this rule, but every slot here was already filled. Inside one set the engine
              gives each course to a single requirement at a time (maximum bipartite matching), so
              a more constrained requirement kept it — Educational-Objective / Breadth boxes are
              the exception and still double-dip. Plan a different class for this slot, or check
              the boxes under “Counting boxes” below to steer the counting.
            </p>
          )}

          {!gp.satisfied && (
            <Link href={catalogHref(g, term)} className="link mt-1.5 inline-block text-xs">
              Find a course that fits →
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

function sourceNode(source: string | null) {
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    return (
      <Link
        href={source}
        target="_blank"
        rel="noopener noreferrer"
        className="link text-xs"
        title="Opens the published source in a new tab"
      >
        source: {truncate(source, 64)}
      </Link>
    );
  }
  return (
    <span className="text-xs text-ink-400">
      source: <span className="kbd">{source}</span>
    </span>
  );
}

function renderSet(p: SetProgress, term: string) {
  const { set } = p;
  const registrar = SCHOOLS.find((s) => s.code === set.school)?.registrarUrl;
  return (
    <SetCard
      key={set.id}
      id={`set-${set.id}`}
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-base font-bold text-ink-900">{set.name}</h3>
              <span className="chip border-brand-300 bg-white text-brand-700">
                {KIND_LABEL[set.kind] ?? set.kind}
              </span>
              <SchoolBadge code={set.school} small />
              {set.degree_years && (
                <span className="chip border-ink-200 bg-white text-ink-500">
                  {set.degree_years}-year plan
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {sourceNode(set.source)}
              {registrar && (
                <Link
                  href={registrar}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link text-xs"
                >
                  {schoolShort(set.school)} registrar
                </Link>
              )}
            </div>
          </div>

          <div className="w-full shrink-0 sm:w-64">
            <div className="flex items-baseline justify-between text-xs text-ink-500">
              <span>
                {p.satisfiedGroups}/{p.totalGroups} required groups
              </span>
              <span className="text-sm font-bold tabular-nums text-ink-900">
                {p.totalGroups ? `${p.percent}%` : "—"}
              </span>
            </div>
            <div
              className="mt-1 h-2 w-full overflow-hidden rounded-full bg-ink-200"
              role="img"
              aria-label={`${p.totalGroups ? p.percent : 0} percent of required groups satisfied`}
            >
              <div
                className={cn("h-full rounded-full", p.percent >= 100 ? "bg-emerald-600" : "bg-brand-500")}
                style={{ width: `${Math.min(100, p.totalGroups ? p.percent : 0)}%` }}
              />
            </div>
            <p className="mt-1 text-right text-xs tabular-nums text-ink-600">
              {cr(p.creditsPlanned)} 5C credits planned
              {p.creditsRequired !== null ? ` of ${cr(p.creditsRequired)}` : ""}
            </p>
          </div>
        </div>
      }
    >
      {set.notes && <p className="text-sm leading-relaxed text-ink-600">{set.notes}</p>}
      {set.groups.length === 0 ? (
        <p className={set.notes ? "mt-2 text-sm text-ink-500" : "text-sm text-ink-500"}>
          This set has no groups defined yet — it is a placeholder in{" "}
          <span className="kbd">data/requirements/</span>.
        </p>
      ) : (
        <ul className={cn("flex flex-col gap-2", set.notes && "mt-2")}>
          {p.groups.map((gp) => renderGroup(gp, term, set))}
        </ul>
      )}
    </SetCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Lab tracker                                                                */
/* -------------------------------------------------------------------------- */

/** X/Y progress chip for a prose sub-requirement (lab count, 100+ count). */
function subChip(x: number, y: number, unit: string, title: string) {
  const done = x >= y;
  return (
    <span
      className={cn(
        "chip",
        done
          ? "border-emerald-300 bg-white text-emerald-800"
          : x > 0
            ? "border-amber-300 bg-white text-amber-800"
            : "border-ink-200 bg-white text-ink-500",
      )}
      title={title}
    >
      {done ? "✓ " : ""}
      {x}/{y} {unit}
      {done ? " met" : ""}
    </span>
  );
}

/** Lab counter: a bar plus a plain "do I need another lab?" answer. */
function LabMeter({
  summary,
  label,
  catalogLink,
}: {
  summary: { have: number; need: number; remaining: number; unnumbered: number };
  label: string;
  catalogLink?: string;
}) {
  const { have, need, remaining, unnumbered } = summary;
  if (need === 0 && unnumbered === 0) return null;
  const pct = need ? Math.round((have / need) * 100) : 0;
  const done = need > 0 && remaining === 0;
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5",
        done ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-bold text-ink-900">{label}</span>
        {need > 0 && (
          <span className="text-sm font-semibold tabular-nums text-ink-800">
            {have} of {need} lab class{need === 1 ? "" : "es"}
          </span>
        )}
        <span className={cn("text-sm font-semibold", done ? "text-emerald-800" : "text-amber-800")}>
          {need === 0
            ? "lab count not stated — see below"
            : done
              ? "✓ lab requirement met"
              : `Take ${remaining} more lab class${remaining === 1 ? "" : "es"}`}
        </span>
        {!done && catalogLink && (
          <Link href={catalogLink} className="link ml-auto text-xs">
            Find a lab →
          </Link>
        )}
      </div>
      {need > 0 && (
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-white ring-1 ring-ink-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={need}
          aria-valuenow={have}
          aria-label={`${label}: ${have} of ${need} lab classes`}
        >
          <div
            className={cn("h-full rounded-full", done ? "bg-emerald-500" : "bg-amber-500")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {unnumbered > 0 && (
        <p className="mt-1 text-[11px] text-ink-500">
          Plus {unnumbered} requirement{unnumbered === 1 ? "" : "s"} that mention labs without a
          number — not counted above.
        </p>
      )}
    </div>
  );
}

/** One row in the "Lab requirements" section. */
function renderLabRow(item: LabItem, term: string) {
  const { gp, tier } = item;
  const g = gp.group;

  const counts: string[] = [];
  if (g.min_courses)
    counts.push(`${gp.haveCourses}/${g.min_courses} course${g.min_courses === 1 ? "" : "s"}`);
  if (g.min_credits) counts.push(`${cr(gp.haveCredits)}/${cr(g.min_credits)} 5C credits`);

  /* Prose sub-requirements: the checklist rule counts the whole group, but
     the catalog prose demands laboratory and/or upper-division courses.
     Both sub-counts are tracked live over the courses that count for it. */
  if (tier === "note" || tier === "upper") {
    const labChip =
      item.labNeed != null ? (
        subChip(
          item.labCount,
          item.labNeed,
          "labs",
          `Catalog prose requires at least ${item.labNeed} laboratory course${
            item.labNeed === 1 ? "" : "s"
          } in this group; ${item.labCount} of your counted courses are labs (L subscript or a lab word in the title).`,
        )
      ) : tier === "note" ? (
        <span
          className="chip border-ink-200 bg-white text-ink-500"
          title="The catalog prose mentions labs in this group without a fixed number."
        >
          {item.counted.length > 0
            ? `${item.labCount} lab${item.labCount === 1 ? "" : "s"} among ${item.counted.length} counted`
            : "no courses counted yet"}
        </span>
      ) : null;
    const upperChip =
      item.upperNeed != null ? (
        subChip(
          item.upperCount,
          item.upperNeed,
          `numbered ${item.minNum}+`,
          `Catalog prose requires ${item.upperNeed} course${
            item.upperNeed === 1 ? "" : "s"
          } numbered ${item.minNum} or higher in this group; ${item.upperCount} of your counted courses qualify.`,
        )
      ) : null;
    return (
      <li
        key={g.id}
        className={cn(
          "rounded-lg border px-3 py-2.5",
          tier === "note" ? "border-amber-200 bg-amber-50/40" : "border-indigo-200 bg-indigo-50/40",
        )}
      >
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5">
            {tier === "note" ? "🔬" : "🎓"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-ink-900">{g.name}</span>
              {labChip}
              {upperChip}
              {counts.length > 0 && (
                <span className="text-xs font-semibold tabular-nums text-ink-700">
                  {counts.join(" · ")}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-600">{truncate(g.notes ?? "", 340)}</p>
            {!gp.satisfied && (
              <Link href={catalogHref(g, term)} className="link mt-1.5 inline-block text-xs">
                Browse courses in this group →
              </Link>
            )}
          </div>
        </div>
      </li>
    );
  }

  /* A lab requirement in its own right — same state math as the checklist. */
  const state: "full" | "half" | "empty" = gp.satisfied ? "full" : gp.partial ? "half" : "empty";
  const shown = [...gp.matched];
  for (const s of gp.pinned) if (!shown.some((x) => x.id === s.id)) shown.push(s);
  return (
    <li
      key={g.id}
      className={cn(
        "rounded-lg border px-3 py-2.5",
        gp.satisfied
          ? "border-emerald-200 bg-emerald-50/50"
          : gp.partial
            ? "border-amber-200 bg-amber-50/50"
            : "border-ink-200 bg-white",
      )}
    >
      <div className="flex items-start gap-2">
        {stateGlyph(state)}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-ink-900">{g.name}</span>
            <span
              className={cn(
                "chip",
                gp.satisfied
                  ? "border-emerald-300 bg-white text-emerald-800"
                  : gp.partial
                    ? "border-amber-300 bg-white text-amber-800"
                    : "border-ink-200 bg-ink-50 text-ink-500",
              )}
            >
              {gp.satisfied ? "satisfied" : gp.partial ? "in progress" : "not met"}
            </span>
            {counts.length > 0 ? (
              <span className="text-xs font-semibold tabular-nums text-ink-700">
                {counts.join(" · ")}
              </span>
            ) : (
              <span className="text-xs text-ink-400">no course floor recorded</span>
            )}
          </div>
          {g.notes && (
            <p className="mt-1 text-xs leading-relaxed text-ink-500">{truncate(g.notes, 220)}</p>
          )}
          {shown.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {shown.slice(0, MAX_CHIPS).map((s) => courseChip(s, false))}
              {shown.length > MAX_CHIPS && (
                <li className="chip border-ink-200 bg-white text-ink-500">
                  +{shown.length - MAX_CHIPS} more
                </li>
              )}
            </ul>
          )}
          {gp.pinned.length > 0 && (
            <p className="mt-1 text-[11px] text-indigo-700">
              📌 {gp.pinned.length} course{gp.pinned.length === 1 ? "" : "s"} counted here via
              checked box
            </p>
          )}
          {!gp.satisfied && (
            <Link href={catalogHref(g, term)} className="link mt-1.5 inline-block text-xs">
              Find a course that fits →
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default async function RequirementsPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const user = await currentUser();

  /* Guests: read-only preview of one campus's published sets, nothing ticked. */
  const askedSchool = one(sp.school).toUpperCase();
  const school = STUDENT_SCHOOLS.some((s) => s.code === askedSchool) ? askedSchool : "CM";

  // Every DB read this page needs is independent once (user, school) are
  // known — one parallel fan-out (was ~10 serial Turso round-trips).
  const [cur, pref, loaded, manuals, plannedEnrolled, sets, assignments, lxKeys, termIds, abroadTerms] = await Promise.all([
    currentTermId(),
    one(sp.term) ? Promise.resolve("") : preferredTerm(),
    requirementsLoaded(),
    user ? manualCoursesFor(user.id) : Promise.resolve([] as ManualCourse[]),
    user ? enrolledSections(user.id) : Promise.resolve([] as Section[]),
    user ? setsForUser(user) : listSets({ school }),
    user ? assignmentsFor(user.id) : Promise.resolve(null),
    labLxKeys(),
    user ? plannedTerms(user.id) : Promise.resolve([] as string[]),
    user ? abroadTermsFor(user.id) : Promise.resolve([] as string[]),
  ]);

  const term = one(sp.term) || pref || cur;
  const scope = one(sp.scope) === "term" ? "term" : "all";

  // Manually entered courses (study abroad, transfer, create-your-own) become
  // pseudo-sections and count alongside catalog sections.
  const manualSections = user ? manuals.map((m) => manualPseudoSection(m, user.school)) : [];
  const plannedAll = user ? [ ...plannedEnrolled, ...manualSections] : [];
  const planned = user && scope === "term" ? plannedAll.filter((s) => s.term_id === term) : plannedAll;
  // For signed-in users the matcher honours checked boxes: courses are pinned
  // into the groups they were checked for. One course may be checked in
  // several sets, and Educational-Objective / Breadth groups may also take a
  // course that already counts elsewhere in the same set. Pass the
  // assignments we already fetched so progressForUser doesn't re-read them.
  const progress = user
    ? await progressForUser(user, planned, assignments ? { assignments } : {})
    : sets.map((s) => progressForSet(s, planned));
  /** Checked boxes for one course — catalog section or manual pseudo-section. */
  const boxesFor = (s: Section) => {
    const list = s.manual
      ? (assignments?.manuals.get(s.id) ?? [])
      : (assignments?.sections.get(s.id) ?? []);
    return {
      ids: list.map((a) => a.groupId),
      note: list.map((a) => a.note).find((n) => n) ?? null,
    };
  };
  const noticeOk = one(sp.ok);
  const noticeErr = one(sp.err);
  /** Where assignment forms land, keeping the current term/scope. */
  const nextHref = hrefFor(sp, { ok: undefined, err: undefined });

  /** The "term" of a course: real term id, or the free-text label for
   *  manually entered courses (summer abroad etc.). */
  const termOf = (s: Section) => s.term_id || s.manual?.termLabel || "Other";

  const termChoices = user
    ? Array.from(
        new Set([cur, ...termIds, ...(term ? [term] : [])]),
      ).sort((a, b) => termKey(b) - termKey(a))
    : [];

  const byKind = (kind: string) => progress.filter((p) => p.set.kind === kind);
  const geSets = byKind("ge");
  const majorSets = byKind("major");
  const minorSets = byKind("minor");

  /**
   * Lab tracker. Signed-in students see lab-related boxes from every set they
   * track — campus GE plus major / second major / minor, which may be from
   * another campus. Guests preview only their campus's GE set: program labs
   * depend on the major a guest hasn't picked yet.
   */
  const labItems = labItemsFor(
    user ? progress : progress.filter((p) => p.set.kind === "ge"),
    lxKeys,
  );
  /** Lab items grouped by set, keeping the set order of `progress`. */
  const labBySet = (() => {
    const map = new Map<string, { set: RequirementSet; items: LabItem[] }>();
    for (const it of labItems) {
      const e = map.get(it.set.id) ?? { set: it.set, items: [] };
      e.items.push(it);
      map.set(it.set.id, e);
    }
    return [...map.values()];
  })();

  const totalGroups = progress.reduce((a, p) => a + p.totalGroups, 0);
  const satisfiedGroups = progress.reduce((a, p) => a + p.satisfiedGroups, 0);
  const overall = totalGroups ? Math.round((satisfiedGroups / totalGroups) * 100) : 0;
  const credits5c = Number(planned.reduce((a, s) => a + s.credits_5c, 0).toFixed(2));
  const halfCredits = Number(
    planned.filter((s) => s.credits_5c < 1).reduce((a, s) => a + s.credits_5c, 0).toFixed(2),
  );
  const planTerms = Array.from(new Set([...plannedAll.map(termOf), ...abroadTerms])).sort(
    (a, b) => termKey(b) - termKey(a),
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <TermRemember term={term} />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Requirement checklist</h1>
          {user ? (
            <p className="mt-1 text-sm text-ink-600">
              {user.name} · {schoolShort(user.school)}
              {user.grad_year ? ` · class of ${user.grad_year}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-600">
              Previewing the published sets for {schoolShort(school)}. Nothing is ticked until you
              plan courses.
            </p>
          )}
        </div>
        {!user && (
          <div className="flex flex-wrap gap-2">
            <Link href="/signup" className="btn-primary">
              Create account
            </Link>
            <Link href="/login" className="btn-secondary">
              Sign in to track progress
            </Link>
          </div>
        )}
      </header>

      {noticeErr && (
        <div className="card card-pad border-red-300 bg-red-50 text-sm text-red-800">{noticeErr}</div>
      )}
      {noticeOk && (
        <div className="card card-pad border-emerald-300 bg-emerald-50 text-sm text-emerald-800">
          {noticeOk}
        </div>
      )}

      {!loaded && (
        <div className="card card-pad border-amber-300 bg-amber-50">
          <p className="font-semibold text-amber-900">Checklists are being put together.</p>
          <p className="mt-1 text-sm text-amber-800">
            Graduation-requirement definitions are under review with the registrar, so the
            checklist tables are empty for now. Planning courses in the Planner and Catalog works
            normally — check back here soon.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="card card-pad flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="label">Count</span>
          <div className="flex flex-wrap gap-1.5">
            <Link
              href={hrefFor(sp, { scope: "all" })}
              aria-current={scope === "all" ? "true" : undefined}
              className={scope === "all" ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
            >
              Every planned term
            </Link>
            <Link
              href={hrefFor(sp, { scope: "term" })}
              aria-current={scope === "term" ? "true" : undefined}
              className={scope === "term" ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
            >
              This term only
            </Link>
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {scope === "all"
              ? `Multi-year audit: all ${plannedAll.length} planned course${plannedAll.length === 1 ? "" : "s"} count${plannedAll.length === 1 ? "s" : ""} toward every box.`
              : `Only ${termLabel(term)} counts toward the boxes below.`}
          </p>
        </div>

        {user ? (
          <form method="get" action="/requirements" className="flex items-end gap-2">
            <input type="hidden" name="scope" value={scope} />
            <div>
              <label className="label" htmlFor="term">
                Plan term
              </label>
              <select id="term" name="term" defaultValue={term} className="input w-auto">
                {termChoices.length === 0 && <option value={term}>{term || "no terms synced"}</option>}
                {termChoices.map((t) => (
                  <option key={t} value={t}>
                    {termLabel(t)}
                    {t === cur ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-secondary">
              Apply
            </button>
          </form>
        ) : (
          <div>
            <span className="label">Campus</span>
            <div className="flex flex-wrap gap-1.5">
              {STUDENT_SCHOOLS.map((s) => (
                <Link
                  key={s.code}
                  href={hrefFor(sp, { school: s.code })}
                  aria-current={s.code === school ? "true" : undefined}
                  className={
                    s.code === school
                      ? "btn-primary px-3 py-1.5 text-xs"
                      : "btn-secondary px-3 py-1.5 text-xs"
                  }
                  title={s.name}
                >
                  {s.short}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Summary strip */}
      <section className="card card-pad" aria-label="Progress summary">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="label">Overall</p>
            <p className="text-2xl font-bold tabular-nums text-ink-900">{totalGroups ? `${overall}%` : "—"}</p>
          </div>
          <div>
            <p className="label">Groups satisfied</p>
            <p className="text-2xl font-bold tabular-nums text-ink-900">
              {satisfiedGroups}
              <span className="text-base font-semibold text-ink-500">/{totalGroups}</span>
            </p>
          </div>
          <div>
            <p className="label">5C credits in plan</p>
            <p className="text-2xl font-bold tabular-nums text-ink-900">{cr(credits5c)}</p>
          </div>
          <div>
            <p className="label">Courses</p>
            <p className="text-2xl font-bold tabular-nums text-ink-900">{planned.length}</p>
          </div>
        </div>
        {halfCredits > 0 && (
          <p className="mt-1.5 text-xs leading-relaxed text-sky-700">
            {cr(halfCredits)} of those 5C credits come from 0.5-credit courses. They count toward
            your graduation total (32 credits) but do <em>not</em> tick a GE or Breadth box — a full
            credit is needed for those.
          </p>
        )}
        {progress.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {progress.map((p) => (
              <li key={p.set.id}>
                <a href={`#set-${p.set.id}`} className="chip border-ink-300 bg-white text-ink-700 hover:bg-ink-100">
                  {p.set.name}
                  <span className="text-ink-400">
                    {p.satisfiedGroups}/{p.totalGroups} · {p.totalGroups ? `${p.percent}%` : "—"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {scope === "all" && planTerms.length > 0 && (
          <p className="mt-2 text-xs text-ink-500">
            Counting from {planTerms.map(termLabel).join(", ")}.
          </p>
        )}
      </section>

      {/* Lab requirements — cross-set rollup of everything that is a lab box */}
      {labItems.length > 0 && (
        <section className="space-y-3" aria-label="Lab requirements">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-lg font-bold tracking-tight text-ink-900">
              <span aria-hidden className="mr-1.5">
                🧪
              </span>
              Lab requirements
            </h2>
            <p className="text-xs text-ink-500">
              {user
                ? "Every lab-related box across your sets — majors and minors from any of the five campuses count, with lab and upper-division sub-counts from catalog prose."
                : `Lab boxes in ${schoolShort(school)} general education. Program-specific labs appear here once you sign in and pick a major.`}
            </p>
          </div>

          {user && (
            <LabMeter
              label="All your programs"
              summary={labSummary(labItems)}
              catalogLink={`/catalog?q=lab&term=${term}`}
            />
          )}

          {labBySet.map(({ set, items }) => {
            const boxes = items.filter((i) => i.tier === "group");
            const met = boxes.filter((i) => i.gp.satisfied).length;
            const summary = labSummary(items);
            const firstOpen = items.find((i) => i.tier !== "upper" && !i.gp.satisfied);
            return (
              <div key={set.id} className="card card-pad">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="text-base font-bold text-ink-900">{set.name}</h3>
                  <span className="chip border-brand-300 bg-white text-brand-700">
                    {KIND_LABEL[set.kind] ?? set.kind}
                  </span>
                  <SchoolBadge code={set.school} small />
                  {boxes.length > 0 && (
                    <span className="ml-auto text-xs tabular-nums text-ink-600">
                      {met}/{boxes.length} lab box{boxes.length === 1 ? "" : "es"} met
                    </span>
                  )}
                </div>
                <div className="mt-2">
                  <LabMeter
                    label={`${set.name} labs`}
                    summary={summary}
                    catalogLink={firstOpen ? catalogHref(firstOpen.gp.group, term) : undefined}
                  />
                </div>
                <ul className="mt-2 flex flex-col gap-2">
                  {items.map((it) => renderLabRow(it, term))}
                </ul>
              </div>
            );
          })}

          <p className="text-xs leading-relaxed text-ink-500">
            Lab boxes are counted by the same matching engine as the checklist below — a lab from
            any campus (HMC “… Laboratory” courses, Keck “L” subscripts, Pomona “with Lab” sections,
            …) ticks its box wherever the rule allows it. A course counts as a lab when its code
            carries an L subscript (NEUR 148L) or its title names a lab.
            {user && (
              <>
                {" "}
                Use <span className="kbd">Counting boxes</span> to pin a specific course to a
                requirement.
              </>
            )}{" "}
            Chips like “2/3 labs” and “4/6 numbered 100+” track the sub-requirements the catalog
            prose states — edge cases are worth confirming with your adviser.
          </p>
        </section>
      )}

      {!user && (
        <section className="card card-pad border-brand-300 bg-ink-50">
          <p className="font-semibold text-ink-900">Want your own checklist?</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-700">
            Sign up (or sign in) and 5Cycle drives this page from your campus, major and minor plus
            the sections you place in the planner — including courses taken at all five campuses. The
            preview below is read-only and shows nothing ticked.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/signup" className="btn-primary">
              Create account
            </Link>
            <Link href="/login" className="btn-secondary">
              Sign in
            </Link>
          </div>
        </section>
      )}

      {/* Full plan — every course the student has saved or entered, across all terms */}
      {user && plannedAll.length > 0 && (
        <section className="card card-pad" aria-label="Your full plan, all terms">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-bold tracking-tight">
              Your full plan — {plannedAll.length} course{plannedAll.length === 1 ? "" : "s"} across{" "}
              {planTerms.length} term{planTerms.length === 1 ? "" : "s"}
            </h2>
            <Link href="/planner" className="link text-sm">
              Open planner →
            </Link>
          </div>
          <p className="mt-1 text-xs text-ink-500">
            Everything you have saved or entered by hand (🌍 study abroad, 📦 transfer, ✏️
            create-your-own) so far. The checklist below counts all of it by default (switch to
            “This term only” to audit a single term — manual courses under a term you haven't
            synced, like an older “Summer 2027 (abroad)” entry, only appear in the all-terms view).
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {planTerms.map((t) => {
              const list = plannedAll.filter((s) => termOf(s) === t);
              return (
                <div key={t}>
                  <p className="label">
                    {termLabel(t)} <span className="text-ink-400">· {list.length} course{list.length === 1 ? "" : "s"}</span>
                    {abroadTerms.includes(t) && (
                      <Link
                        href="/planner"
                        className="chip ml-1.5 border-sky-300 bg-sky-50 normal-case text-sky-800"
                        title="Marked as a study-abroad term in your planner"
                      >
                        🌍 Study abroad
                      </Link>
                    )}
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {list.map((s) => (
                      <li key={s.id}>
                        {s.manual ? (
                          <span
                            className="chip border-violet-300 bg-violet-50 font-mono text-violet-900"
                            title={`${s.title} — ${s.manual.kind} · ${cr(s.credits_5c)} 5C credits`}
                          >
                            <span aria-hidden>{manualGlyph(s)}</span> {s.code_string}
                          </span>
                        ) : (
                          <Link
                            href={`/section/${encodeURIComponent(s.id)}`}
                            className="chip border-ink-200 bg-white font-mono text-ink-700 hover:bg-ink-50"
                            title={s.title}
                          >
                            {s.code_string}
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Counting boxes: multi-box manual assignment + manual courses */}
      {user && (
        <section className="card card-pad" aria-label="Counting boxes — manual requirement assignment">
          <h2 className="text-base font-bold tracking-tight">
            Counting boxes — advisor designations, manual courses &amp; double-dip control
          </h2>
          <p className="mt-1 text-sm font-medium text-ink-800">
            Check the boxes you want each course to count toward. Boxes it can&apos;t count toward
            are greyed out.
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-600">
            <li>
              <strong>GE:</strong> a course can only be checked toward a GE requirement it actually
              has (its course-area designation).
            </li>
            <li>
              <strong>Educational Objectives &amp; Breadth of Knowledge:</strong> one course may
              count toward one box in <em>each</em>, but never two boxes inside the same one — once
              you pick a box there, the others close.
            </li>
            <li>
              <strong>Major &amp; minor:</strong> inside one major or minor a course fills only{" "}
              <strong>one</strong> box — once you pick it, that program&apos;s other boxes lock. How
              many courses can be shared <em>between</em> programs depends on your college, and
              boxes close when that limit is used up.{" "}
              <span className="text-ink-500">{overlapPolicyFor(user?.school).summary}</span>
            </li>
            <li>
              <strong>Named requirements:</strong> when a major or minor lists a course by name
              (for example “take CSCI 081”), that course counts toward it automatically — the box
              shows ticked and locked, and the program&apos;s other boxes lock for that course.
            </li>
            <li>
              <strong>Advisor exceptions:</strong> if a course doesn&apos;t officially fit a major or
              minor box but your advisor chose or approved it, you can still save it — you&apos;ll
              get a warning to confirm first.
            </li>
            <li>
              A 0.5-credit course can&apos;t tick a GE or Breadth box (a full credit is needed); its
              credits still count toward your 32-credit total. Uncheck everything or press “Release
              all” to let the engine decide.
            </li>
          </ul>

          {plannedAll.length > 0 ? (
            <ul className="mt-3 divide-y divide-ink-100">
              {[...plannedAll]
                .sort((a, b) => termKey(termOf(b)) - termKey(termOf(a)) || a.id.localeCompare(b.id))
                .map(async (s) => {
                  const { ids: currentIds, note: currentNote } = boxesFor(s);
                  const auto = fulfillmentFor(s, sets);
                  const isManual = !!s.manual;
                  return (
                    <li key={s.id} className="py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {isManual ? (
                          <span className="font-mono text-sm font-bold text-violet-900">
                            <span aria-hidden>{manualGlyph(s)}</span> {s.code_string}
                          </span>
                        ) : (
                          <Link
                            href={`/section/${encodeURIComponent(s.id)}`}
                            className="font-mono text-sm font-bold text-ink-900 hover:underline"
                          >
                            {s.code_string}
                          </Link>
                        )}
                        <span className="chip border-ink-200 bg-ink-50 text-ink-500">
                          {termLabel(termOf(s))}
                        </span>
                        {s.credits_5c < 1 && (
                          <span
                            className="chip border-sky-200 bg-sky-50 text-sky-700"
                            title="0.5-credit course — counts toward your total but not toward GE or Breadth boxes."
                          >
                            0.5 cr
                          </span>
                        )}
                        {currentIds.length > 0 ? (
                          <span
                            className="chip border-violet-300 bg-violet-50 text-violet-800"
                            title={currentNote ?? "Checked by you"}
                          >
                            📌 counting toward {currentIds.length} box{currentIds.length === 1 ? "" : "es"}:{" "}
                            {(await Promise.all(
                              currentIds.map(async (g) => (await groupLabel(g)) ?? g),
                            )).join("; ")}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-400">
                            automatic —{" "}
                            {auto.length > 0
                              ? `could count toward ${auto.slice(0, 3).map((f) => `${f.setName} · ${f.groupName}`).join("; ")}${auto.length > 3 ? ` (+${auto.length - 3} more)` : ""}`
                              : "no rule match yet (check boxes below to designate it)"}
                          </span>
                        )}
                      </div>

                      <details className="mt-2">
                        <summary className="cursor-pointer select-none text-xs font-semibold text-ink-700">
                          {currentIds.length > 0
                            ? "Edit the checked boxes"
                            : "Check the boxes this course counts toward"}
                        </summary>
                        <form
                          action={saveCourseCounting}
                          className="mt-2 space-y-3 rounded-lg border border-ink-100 bg-ink-50/50 p-3"
                        >
                          <input type="hidden" name="courseId" value={s.id} />
                          <input type="hidden" name="courseKind" value={isManual ? "manual" : "section"} />
                          <input type="hidden" name="next" value={nextHref} />
                          <GroupCheckboxes
                            key={currentIds.join(",")}
                            sets={countingSetsFor(sets, s)}
                            checked={currentIds}
                            policy={overlapPolicyFor(user.school)}
                  pairUse={pairUseFrom(assignments ?? { sections: new Map(), manuals: new Map() }, sets, s.id, plannedAll)}
                            strictGe={!isManual}
                            half={s.credits_5c < 1}
                          />
                          <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
                            <input
                              type="text"
                              name="note"
                              defaultValue={currentNote ?? ""}
                              placeholder="advisor note (optional)"
                              className="input w-56 max-w-full text-xs"
                            />
                            <button type="submit" className="btn-secondary text-xs">
                              Save boxes
                            </button>
                            <button type="submit" name="release" value="1" className="btn-ghost text-xs">
                              ↩ Release all — let the engine decide
                            </button>
                          </div>
                        </form>
                      </details>

                      {isManual && (
                        <form action={removeManualCourseAction} className="mt-2">
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="next" value={nextHref} />
                          <button type="submit" className="btn-ghost text-xs text-red-600">
                            🗑 Remove this manual course
                          </button>
                        </form>
                      )}
                    </li>
                  );
                })}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-600">
              Nothing planned or entered yet — add classes from the catalog, or type them into the
              course schedule on the planner.
            </p>
          )}
        </section>
      )}

      {/* GE */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold tracking-tight text-ink-900">
          {user ? `${schoolShort(user.school)} general education` : `${schoolShort(school)} general education`}
        </h2>
        {geSets.length > 0 ? (
          geSets.map((p) => renderSet(p, term))
        ) : user ? (
          <p className="card card-pad text-sm text-ink-600">
            No GE set is defined for {schoolShort(user.school)} yet.
          </p>
        ) : (
          <p className="card card-pad text-sm text-ink-600">
            No GE set is defined for {schoolShort(school)} yet — pick another campus above.
          </p>
        )}
      </section>

      {/* Major */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold tracking-tight text-ink-900">Major</h2>
        {majorSets.length > 0 ? (
          majorSets.map((p) => renderSet(p, term))
        ) : user ? (
          <div className="card card-pad flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-600">
              You haven&apos;t chosen a major, so there&apos;s nothing to check against.
            </p>
            <Link href="/profile" className="btn-secondary">
              Choose a major in your profile →
            </Link>
          </div>
        ) : (
          <p className="card card-pad text-sm text-ink-600">
            No major set is defined for {schoolShort(school)} yet — try another campus above.
          </p>
        )}
      </section>

      {/* Minor */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold tracking-tight text-ink-900">Minor</h2>
        {minorSets.length > 0 ? (
          minorSets.map((p) => renderSet(p, term))
        ) : user ? (
          <div className="card card-pad flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-600">
              You haven&apos;t chosen a minor. Minors are optional at most 5C campuses — add one only
              if you plan to graduate with it.
            </p>
            <Link href="/profile" className="btn-secondary">
              Choose a minor in your profile →
            </Link>
          </div>
        ) : (
          <p className="card card-pad text-sm text-ink-600">
            No minor set is defined for {schoolShort(school)} yet — try another campus above.
          </p>
        )}
      </section>

      {/* Double-counting policy note — driven by the same table the counting boxes use */}
      <section className="space-y-3" aria-label="5C Double Counting Policy">
        <h2 className="text-lg font-bold tracking-tight text-ink-900">5C Double Counting Policy</h2>
        <div className="card card-pad space-y-3 text-sm leading-relaxed text-ink-700">
          <p>
            The five colleges are independent, so how many courses you can count toward two
            programs (two majors, a major and a minor, or a program and a General Education
            requirement) <strong>depends on your home college</strong> — there is no
            consortium-wide rule. The counting boxes in your checklist follow these limits.{" "}
            <strong>Check with advisors.</strong>
          </p>
          <ul className="space-y-2">
            {SCHOOLS.map((sc) => {
              const pol = OVERLAP_POLICY[sc.code];
              if (!pol) return null;
              const mine = user?.school === sc.code;
              return (
                <li
                  key={sc.code}
                  className={mine ? "rounded-lg border border-brand-300 bg-brand-50/50 p-2.5" : "p-2.5"}
                >
                  <strong>{sc.name}</strong>
                  {mine && <span className="chip ml-2 border-brand-300 bg-white text-brand-700">your college</span>}
                  <span className="mt-0.5 block text-ink-600">{pol.summary}</span>
                  {POLICY_LINKS[sc.code] && (
                    <a className="link text-xs" href={POLICY_LINKS[sc.code]} target="_blank" rel="noreferrer">
                      Official policy →
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-ink-500">
            General guidance, not official policy — departments can set stricter or looser rules.
            Confirm with your college&rsquo;s catalog and your department before you count a course
            twice.
          </p>
        </div>
      </section>

    </div>
  );
}
