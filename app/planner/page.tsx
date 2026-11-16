/**
 * The planner: this term's saved courses, the weekly grid, the conflicts, and
 * how much of the requirement checklist the plan currently satisfies.
 *
 * Mutations go through Server Actions (see lib/server.ts for why the browser
 * never calls /api/* directly in this sandbox).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  addManualCourseAction,
  removeManualCourseAction,
  setAbroadAction,
} from "@/actions/requirements";
import { EnrollButton } from "@/components/EnrollButton";
import { SchoolBadge } from "@/components/SectionCard";
import { Stars } from "@/components/Stars";
import { Timetable } from "@/components/Timetable";
import { TermSelect } from "@/components/TermSelect";
import { GroupCheckboxes } from "@/components/GroupCheckboxes";
import { SCHOOLS, SCHOOL_BY_CODE } from "@/lib/constants";
import { facets } from "@/lib/catalog";
import {
  findConflicts,
  listEnrollments,
  summarizeTerm,
  type Enrollment,
  type TermSummary,
} from "@/lib/schedule";
import { currentUser } from "@/lib/session";
import {
  abroadFlagsFor,
  manualCoursesFor,
  manualPseudoSection,
  progressForUser,
  setsForUser,
} from "@/lib/requirements";
import type { Section } from "@/lib/types";
import { currentTermId } from "@/lib/ingest";
import { permNeededFor } from "@/lib/perm";
import {
  formatCredits,
  secondsTo12h,
  schoolShort,
  termLabel,
  truncate,
} from "@/lib/util";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: SP[string]) => (Array.isArray(v) ? v[0] : v) ?? "";

const PLAN_STATUSES: { value: string; label: string }[] = [
  { value: "planned", label: "Planned" },
  { value: "registered", label: "Registered" },
  { value: "waitlist", label: "Waitlisted" },
  { value: "perm_requested", label: "Perm requested" },
];

/**
 * setStatusAction / clearTermAction take (prev, formData); a plain <form> only
 * passes FormData, so wrap them inline. `next` round-trips the current term.
 */
async function statusForm(fd: FormData) {
  "use server";
  const { setStatusAction } = await import("@/actions/planner");
  const next = fd.get("next")?.toString() || "/planner";
  await setStatusAction(null, fd);
  redirect(next);
}

async function clearForm(fd: FormData) {
  "use server";
  const { clearTermAction } = await import("@/actions/planner");
  const next = fd.get("next")?.toString() || "/planner";
  await clearTermAction(null, fd);
  redirect(next);
}

function manualGlyph(s: Section): string {
  if (!s.manual) return "";
  return s.manual.kind === "abroad" ? "🌍" : s.manual.kind === "transfer" ? "📦" : "✏️";
}

function emptySummary(termId: string): TermSummary {
  return {
    termId,
    count: 0,
    credits5c: 0,
    creditsBySchool: {},
    conflicts: [],
    crossCampus: 0,
    needsPerm: 0,
  };
}

export default async function PlannerPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await currentUser();
  const sp = await searchParams;

  const synced = facets().terms;
  const term = one(sp.term) || currentTermId() || synced[0]?.id || "";
  const selfHref = `/planner?term=${term}`;

  // Guests browse a live-but-empty plan; every user-owned state degrades to
  // its empty form so the same markup renders for both.
  const enrollments = user ? listEnrollments(user.id, term) : [];
  const sections = enrollments.map((e) => e.section);
  // Manually entered courses (study-abroad classes, transfer credit,
  // create-your-own) show up alongside catalog sections for this term.
  const manualSections = user
    ? manualCoursesFor(user.id)
        .filter((m) => m.term_id === term)
        .map((m) => manualPseudoSection(m, user.school))
    : [];
  const allSections = [...sections, ...manualSections];
  const manualCredits = Number(
    manualSections.reduce((a, s) => a + s.credits_5c, 0).toFixed(2),
  );
  const abroad = user ? abroadFlagsFor(user.id).get(term) === true : false;
  const summary = user ? summarizeTerm(user.id, term, user.school) : emptySummary(term);
  const conflicts = findConflicts(sections);
  const conflicting = new Set<string>();
  for (const c of conflicts) {
    conflicting.add(c.a.id);
    conflicting.add(c.b.id);
  }
  const plannedIds = new Set(sections.map((s) => s.id));
  const sets = user ? setsForUser(user) : [];
  // Checklist includes the manual pseudo-sections so entered credits count.
  const progress = user ? progressForUser(user, allSections) : [];

  const notices = {
    ok: one(sp.ok),
    err: one(sp.err),
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            My plan · {termLabel(term)}
          </h1>
          {user ? (
            <p className="mt-1 text-sm text-ink-600">
              {user.name} · {schoolShort(user.school)}
              {user.grad_year ? ` · class of ${user.grad_year}` : ""}
              {user.advisor ? ` · advisor ${user.advisor}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-600">
              Browsing as a guest —{" "}
              <Link href={`/login?next=${encodeURIComponent(selfHref)}`} className="link">
                sign in
              </Link>{" "}
              or{" "}
              <Link href={`/signup?next=${encodeURIComponent(selfHref)}`} className="link">
                create an account
              </Link>{" "}
              to save a plan.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <form method="get" action="/planner" className="flex items-end gap-2">
            <div>
              <label className="label" htmlFor="term">
                Term
              </label>
              {/* Auto-submits on change, so the grid switches to that term's classes. */}
              <TermSelect options={synced.map((t) => ({ ...t }))} value={term} />
            </div>
            <button type="submit" className="btn-secondary">
              Go
            </button>
            <Link href={`/catalog?term=${term}`} className="btn-primary">
              Add courses
            </Link>
          </form>
          {user && (
            <form action={setAbroadAction} className="flex items-center">
              <input type="hidden" name="termId" value={term} />
              <input type="hidden" name="next" value={selfHref} />
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 hover:bg-ink-50">
                <input
                  type="checkbox"
                  name="abroad"
                  value="1"
                  defaultChecked={abroad}
                  className="h-4 w-4 accent-brand-600"
                />
                🌍 studying abroad this term
              </label>
            </form>
          )}
        </div>
      </header>

      {!user && (
        <div className="card card-pad border-brand-200 bg-brand-50 text-sm text-brand-900">
          <strong>Just looking?</strong> The catalog and this grid are open to browse. When you
          add a course you&apos;ll be sent to sign in or create an account — the course you picked
          comes along and is added to your new plan automatically.
        </div>
      )}

      {notices.err && (
        <div className="card card-pad border-red-300 bg-red-50 text-sm text-red-800">
          {notices.err}
        </div>
      )}
      {notices.ok && (
        <div className="card card-pad border-emerald-300 bg-emerald-50 text-sm text-emerald-800">
          {notices.ok}
        </div>
      )}

      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Courses"
          value={String(summary.count + manualSections.length)}
          hint={manualSections.length ? `${manualSections.length} entered by hand` : undefined}
        />
        <Stat
          label="5C credits"
          value={(summary.credits5c + manualCredits).toFixed(2)}
          hint={
            manualCredits > 0
              ? `incl. ${manualCredits.toFixed(2)} cr entered by hand`
              : "HMC counted at 1/3 of its own scale"
          }
        />
        <Stat
          label="Cross-campus"
          value={String(summary.crossCampus)}
          hint={summary.needsPerm ? `${summary.needsPerm} need a perm` : "all home-campus"}
        />
        <Stat
          label="Time conflicts"
          value={String(conflicts.length)}
          tone={conflicts.length ? "bad" : "good"}
        />
      </div>

      {conflicts.length > 0 && (
        <div className="card card-pad border-amber-300 bg-amber-50">
          <h2 className="text-sm font-bold text-amber-900">
            {conflicts.length} scheduling conflict{conflicts.length === 1 ? "" : "s"}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {conflicts.map((c, i) => (
              <li key={i}>
                <span className="font-mono">{c.a.code_string}</span> and{" "}
                <span className="font-mono">{c.b.code_string}</span> both meet {c.days} at{" "}
                {secondsTo12h(c.start)}–{secondsTo12h(c.end)}. One has to move, or one is a
                deliberate placeholder — mark it as such below.
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left: the list */}
        <div className="space-y-3 lg:col-span-7">
          <h2 className="text-lg font-bold">Saved courses</h2>
          {enrollments.length === 0 && manualSections.length === 0 && (
            <div className="card card-pad text-sm text-ink-600">
              Nothing saved for {termLabel(term)} yet.{" "}
              {!user ? (
                <>
                  You&apos;re browsing as a guest —{" "}
                  <Link href={`/catalog?term=${term}`} className="link">
                    pick a course in the catalog
                  </Link>{" "}
                  and add it, and once you create an account it&apos;ll be waiting here.
                </>
              ) : abroad ? (
                <>
                  This is marked as a study-abroad term, so the catalog won&apos;t have these
                  classes — <strong>enter them by hand</strong> below.
                </>
              ) : (
                <>
                  <Link href={`/catalog?term=${term}`} className="link">
                    Browse the catalog
                  </Link>{" "}
                  and use “Add to plan”, or{" "}
                  <Link href="/profile" className="link">
                    seed a sample term from your account page
                  </Link>{" "}
                  to see how the checklist reacts.
                </>
              )}
            </div>
          )}

          {enrollments.map((e: Enrollment) => {
            if (!user) return null; // unreachable: guests have no enrollments
            const s = e.section;
            const clash = conflicting.has(s.id);
            const perm = permNeededFor(user.school, s);
            return (
              <article
                key={e.id}
                className={`card card-pad space-y-2 ${clash ? "border-amber-400" : ""}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={`/section/${encodeURIComponent(s.id)}`}
                        className="font-mono text-sm font-bold hover:underline"
                      >
                        {s.code_string}
                      </Link>
                      <SchoolBadge code={s.school} small />
                      {clash && (
                        <span className="chip border-amber-400 bg-amber-100 text-amber-800">
                          conflict
                        </span>
                      )}
                      {perm && (
                        <span className="chip border-indigo-300 bg-indigo-50 text-indigo-700">
                          perm needed
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm font-medium text-ink-800">
                      {truncate(s.title, 90)}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatCredits(s.credits_5c, s.school)}
                      {s.school === "HM" && ` · ${s.credits} on HMC's scale`}
                      {" · "}
                      {s.meetings.length
                        ? s.meetings
                            .map(
                              (m) =>
                                `${m.days} ${secondsTo12h(m.start_time)}–${secondsTo12h(m.end_time)}`,
                            )
                            .join("; ")
                        : "no meeting time in feed"}
                    </p>
                    {s.instructors.length > 0 && (
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600">
                        {s.instructors.map((i) => (
                          <Link
                            key={i.id}
                            href={`/professors/${encodeURIComponent(i.id)}`}
                            className="link inline-flex items-center gap-1"
                          >
                            {i.name}
                            <Stars value={i.avg_stars} />
                          </Link>
                        ))}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0">
                    <EnrollButton sectionId={s.id} inPlan={plannedIds.has(s.id)} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
                  <form action={statusForm} className="flex items-center gap-2">
                    <input type="hidden" name="sectionId" value={s.id} />
                    <input type="hidden" name="next" value={selfHref} />
                    <label className="label mb-0" htmlFor={`st-${e.id}`}>
                      Status
                    </label>
                    <select
                      id={`st-${e.id}`}
                      name="status"
                      defaultValue={e.status}
                      className="input w-auto py-1 text-xs"
                    >
                      {PLAN_STATUSES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="btn-secondary px-2 py-1 text-xs">
                      Save
                    </button>
                  </form>
                  {perm && (
                    <a
                      href={SCHOOL_BY_CODE[user.school].registrarUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost px-2 py-1 text-xs"
                    >
                      Open {schoolShort(user.school)} registrar ↗
                    </a>
                  )}
                </div>
              </article>
            );
          })}

          {manualSections.length > 0 && (
            <section aria-label="Courses entered by hand" className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-500">
                Entered by hand{abroad ? " · study abroad" : ""}
              </h3>
              {manualSections.map((s) => {
                if (!user) return null; // unreachable: guests have no manual courses
                return (
                <article key={s.id} className="card card-pad border-violet-200">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-bold text-violet-900">
                          <span aria-hidden>{manualGlyph(s)}</span> {s.code_string}
                        </span>
                        <span className="chip border-violet-200 bg-violet-50 text-violet-700">
                          manual
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm font-medium text-ink-800">{s.title}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {formatCredits(s.credits_5c, user.school)} · not in the catalog, so no
                        meeting times and no conflict checks
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Link href={`/requirements?scope=all`} className="link text-xs">
                        Edit counting boxes →
                      </Link>
                      <form action={removeManualCourseAction}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="next" value={selfHref} />
                        <button type="submit" className="btn-ghost px-2 py-1 text-xs text-red-600">
                          🗑 Remove
                        </button>
                      </form>
                    </div>
                  </div>
                </article>
                );
              })}
            </section>
          )}

          {enrollments.length > 0 && (
            <form action={clearForm} className="flex items-center gap-2">
              <input type="hidden" name="term" value={term} />
              <input type="hidden" name="next" value={selfHref} />
              <button type="submit" className="btn-danger">
                Clear {termLabel(term)}
              </button>
              <span className="text-xs text-ink-500">
                Removes all {enrollments.length} saved course(s) for this term. Other terms are
                untouched.
              </span>
            </form>
          )}

          {/* Enter a course by hand — study abroad, transfer credit, or a
              create-your-own designation with no catalog section. */}
          {user && (
          <form action={addManualCourseAction} className="card card-pad space-y-3">
            <h3 className="text-sm font-bold text-ink-900">
              Enter a course by hand · {termLabel(term)}
            </h3>
            <p className="text-xs leading-relaxed text-ink-500">
              {abroad
                ? "This term is marked study abroad — the catalog won't have these classes, so type them in below."
                : "For classes not in the catalog: study abroad, transfer credit, or a create-your-own designation."}{" "}
              For a summer-abroad program, mark the term abroad first.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-52 flex-1">
                <label className="label" htmlFor="manual-title">
                  Course title
                </label>
                <input
                  id="manual-title"
                  type="text"
                  name="title"
                  required
                  placeholder="e.g. Renaissance Art in Florence"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label" htmlFor="manual-credits">
                  Credits (5C)
                </label>
                <input
                  id="manual-credits"
                  type="number"
                  name="credits"
                  required
                  min="0.25"
                  max="12"
                  step="0.25"
                  defaultValue="3"
                  className="input w-24"
                />
              </div>
              <div>
                <label className="label" htmlFor="manual-kind">
                  Type
                </label>
                <select
                  id="manual-kind"
                  name="kind"
                  defaultValue={abroad ? "abroad" : "custom"}
                  className="input w-auto"
                >
                  <option value="abroad">🌍 Study abroad</option>
                  <option value="transfer">📦 Transfer credit</option>
                  <option value="custom">✏️ Create-your-own</option>
                </select>
              </div>
            </div>
            <input type="hidden" name="termId" value={term} />
            <input type="hidden" name="next" value={selfHref} />
            <div>
              <span className="label">
                Count it toward (optional — check every box it fills, the engine decides the rest)
              </span>
              <div className="mt-1">
                <GroupCheckboxes sets={sets} checked={[]} disabledHalf={false} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                name="note"
                placeholder="advisor note (optional)"
                className="input w-56 max-w-full text-xs"
              />
              <button type="submit" className="btn-primary">
                Add to my plan
              </button>
            </div>
          </form>
          )}
        </div>

        {/* Right: grid + checklist */}
        <div className="space-y-6 lg:col-span-5">
          <section className="card card-pad space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold">Weekly grid</h2>
              <span className="text-xs text-ink-500">08:00 – 22:00</span>
            </div>
            {allSections.length ? (
              <Timetable sections={allSections} />
            ) : (
              <p className="text-sm text-ink-500">
                {abroad
                  ? "Enter this study-abroad term's courses by hand — they'll appear below the grid."
                  : "The grid fills in as you save courses."}
              </p>
            )}
          </section>

          <section className="card card-pad space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold">Checklist snapshot</h2>
              <Link href={`/requirements?term=${term}`} className="link text-sm">
                Full checklist
              </Link>
            </div>
            {!user ? (
              <p className="text-sm text-ink-600">
                Sign in to see how your plan ticks GE, major and minor boxes —{" "}
                <Link href={`/signup?next=${encodeURIComponent(selfHref)}`} className="link">
                  create an account
                </Link>{" "}
                to get your checklist.
              </p>
            ) : sets.length === 0 ? (
              <p className="text-sm text-ink-600">
                No requirement set is attached to your profile yet. Pick your major and minor on{" "}
                <Link href="/profile" className="link">
                  your account page
                </Link>
                .
              </p>
            ) : (
              <ul className="space-y-2">
                {progress.map((p) => (
                  <li key={p.set.id}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-medium">
                        {p.set.name}{" "}
                        <span className="text-xs uppercase text-ink-400">{p.set.kind}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-xs text-ink-600">
                        {p.satisfiedGroups}/{p.totalGroups} · {p.percent}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-200">
                      <div
                        className="h-full rounded-full bg-brand-600"
                        style={{ width: `${p.percent}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {Object.keys(summary.creditsBySchool).length > 0 && (
            <section className="card card-pad space-y-2">
              <h2 className="text-lg font-bold">Load by campus</h2>
              <ul className="space-y-1 text-sm">
                {Object.entries(summary.creditsBySchool)
                  .sort((a, b) => b[1] - a[1])
                  .map(([code, creds]) => (
                    <li key={code} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <SchoolBadge code={code} small />
                        <span className="text-ink-600">
                          {SCHOOLS.find((x) => x.code === code)?.name ?? schoolShort(code)}
                        </span>
                      </span>
                      <span className="tabular-nums">
                        {creds.toFixed(2)} 5C cr
                        {code === "HM" ? " (from HMC scale)" : ""}
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="text-xs text-ink-500">
                Cross-registration caps are set per campus per term — this is a planning number,
                not permission from your registrar.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="card card-pad">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-bold tabular-nums ${
          tone === "bad" ? "text-red-700" : tone === "good" ? "text-emerald-700" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-500">{hint}</div>}
    </div>
  );
}
