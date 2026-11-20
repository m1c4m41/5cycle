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
  saveCourseCounting,
} from "@/actions/requirements";
import { WhatIf } from "@/components/WhatIf";
import { ScrollOnMount } from "@/components/ScrollOnMount";
import { isPinnedPlan } from "@/lib/plan-status";
import { EnrollButton } from "@/components/EnrollButton";
import { SchoolBadge, SeatsMeter } from "@/components/SectionCard";
import { PrereqText } from "@/components/PrereqText";
import { extractPrerequisites } from "@/lib/prereq";
import { Stars } from "@/components/Stars";
import { academicYearOf } from "@/lib/academic-year";
import { SeatAlertToggle } from "@/components/SeatAlertToggle";
import { alertSectionIds } from "@/lib/notify";
import { StatusSelect } from "@/components/StatusSelect";
import { AbroadPicker } from "@/components/AbroadPicker";
import { CourseHistory, type HistoryCourse } from "@/components/CourseHistory";
import { Timetable } from "@/components/Timetable";
import { TermSelect } from "@/components/TermSelect";
import { GroupCheckboxes } from "@/components/GroupCheckboxes";
import { overlapPolicyFor } from "@/lib/counting";
import { SCHOOLS, SCHOOL_BY_CODE } from "@/lib/constants";
import { facets } from "@/lib/catalog";
import {
  findConflicts,
  listEnrollments,
  summarizeTerm,
  type Enrollment,
  type TermSummary,
} from "@/lib/schedule";
import { currentUser, isGuestUser } from "@/lib/session";
import {
  abroadFlagsFor,
  assignmentsFor,
  blankCountingSets,
  countingSetsFor,
  manualCoursesFor,
  pairUseFrom,
  manualPseudoSection,
  progressForUser,
  setsForUser,
} from "@/lib/requirements";
import type { ManualCourse, RequirementSet, Section, SetProgress } from "@/lib/types";
import { currentTermId } from "@/lib/ingest";
import { refreshInBackground } from "@/lib/refresh";
import { preferredTerm } from "@/lib/term-pref";
import { TermRemember } from "@/components/TermRemember";
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
  { value: "perm_requested", label: "Perm requested" },
];

/** clearTermAction takes (prev, formData); a plain <form> only passes FormData, so wrap it inline. */
async function clearForm(fd: FormData) {
  "use server";
  const { clearTermAction } = await import("@/actions/planner");
  const next = fd.get("next")?.toString() || "/planner";
  await clearTermAction(null, fd);
  redirect(next);
}

const termSortKey = (id: string) => {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(id);
  return m ? Number(m[2]) * 10 + (m[1] === "SP" ? 1 : m[1] === "SU" ? 2 : 3) : 0;
};

function manualGlyph(s: Section): string {
  if (!s.manual) return "";
  return s.manual.kind === "abroad" ? "🌍" : s.manual.kind === "transfer" ? "📦" : s.manual.kind === "planned" ? "📌" : s.manual.kind === "summer" ? "☀️" : s.manual.kind === "credit" ? "🎓" : "✏️";
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

  // facets() (no term) and currentTermId() are independent — parallel.
  const [fxAll, curTerm] = await Promise.all([
    facets(),
    one(sp.term) ? Promise.resolve("") : preferredTerm().then((t) => t || currentTermId()),
  ]);
  const synced = fxAll.terms;
  const term = one(sp.term) || curTerm || synced[0]?.id || "";
  refreshInBackground(term);
  const selfHref = `/planner?term=${term}`;

  // Guests browse a live-but-empty plan; every user-owned state degrades to
  // its empty form so the same markup renders for both. All four user reads
  // are independent given (user, term) — one parallel fan-out.
  const [enrollments, manualCourses, abroadMap, summary, assignments, allEnrollments, alertIds] = await Promise.all([
    user ? listEnrollments(user.id, term) : Promise.resolve([] as Enrollment[]),
    user ? manualCoursesFor(user.id) : Promise.resolve([] as ManualCourse[]),
    user ? abroadFlagsFor(user.id) : Promise.resolve(new Map<string, boolean>()),
    user ? summarizeTerm(user.id, term, user.school) : Promise.resolve(emptySummary(term)),
    user ? assignmentsFor(user.id) : Promise.resolve(null),
    user ? listEnrollments(user.id) : Promise.resolve([] as Enrollment[]),
    user ? alertSectionIds(user.id) : Promise.resolve(new Set<string>()),
  ]);
  const sections = enrollments.map((e) => e.section);
  // Manually entered courses (study-abroad classes, transfer credit,
  // create-your-own) show up alongside catalog sections for this term.
  const manualSections = user
    ? manualCourses
        .filter((m) => m.term_id === term)
        .map((m) => manualPseudoSection(m, user.school))
    : [];
  const allSections = [...sections, ...manualSections];
  const manualCredits = Number(
    manualSections.reduce((a, s) => a + s.credits_5c, 0).toFixed(2),
  );
  const liveTerm = await currentTermId(); // the registrar's current term (cached)
  const abroad = user ? abroadMap.get(term) === true : false;
  // Terms for the by-hand form: the selected term, the summer of its academic
  // year (e.g. Summer 2027 for 2026–27), and any term marked abroad.
  const ay = academicYearOf(term);
  // A past term's "+ add manually" link arrives here with ?manual=<term>.
  const manualTerm = /^(FA|SP|SU)\d{4}$/.test(one(sp.manual)) ? one(sp.manual) : "";
  const manualTermChoices = Array.from(
    new Set([...(manualTerm ? [manualTerm] : []), term, ...(ay ? [ay.termIds[2]] : []), ...abroadMap.keys()].filter(Boolean)),
  ).sort((a, b) => termSortKey(a) - termSortKey(b));
  const abroadTerms = [...abroadMap.keys()].sort((a, b) => termSortKey(a) - termSortKey(b));
  // Terms a student can mark as abroad: fall / spring / summer, a few years either
  // side of today, whether or not the catalog has published them yet.
  const abroadOptions = (() => {
    const base = Number((/\d{4}/.exec(liveTerm) ?? [String(new Date().getFullYear())])[0]);
    const out: { id: string; label: string }[] = [];
    for (let y = base - 2; y <= base + 4; y++)
      for (const t of ["SP", "SU", "FA"]) out.push({ id: `${t}${y}`, label: termLabel(`${t}${y}`) });
    return out;
  })();
  // Everything the student has taken / planned, across every term, for the
  // four-year course schedule.
  const history: HistoryCourse[] = [
    ...allEnrollments.map((e) => ({
      id: e.section.id,
      code: e.section.code_string,
      title: e.section.title,
      credits: e.section.credits_5c,
      termId: e.section.term_id,
      termLabel: termLabel(e.section.term_id),
      manual: false,
    })),
    ...manualCourses.map((m) => {
      const label = /(Fall|Spring|Summer)\s+(\d{4})/i.exec(m.term_label);
      const fromLabel = label
        ? `${label[1].toLowerCase() === "fall" ? "FA" : label[1].toLowerCase() === "spring" ? "SP" : "SU"}${label[2]}`
        : null;
      const ps = manualPseudoSection(m, user!.school);
      return {
        id: m.id,
        code: ps.code_string,
        title: m.title,
        credits: m.credits,
        termId: m.term_id ?? fromLabel,
        termLabel: m.term_label,
        manual: true,
        glyph: manualGlyph(ps),
      };
    }),
  ];
  const conflicts = findConflicts(sections);
  const conflicting = new Set<string>();
  for (const c of conflicts) {
    conflicting.add(c.a.id);
    conflicting.add(c.b.id);
  }
  const plannedIds = new Set(sections.map((s) => s.id));
  // "What if": the solid bar is the Checklist (catalog classes + hand-entered credit);
  // the shaded part adds the 📌 pinned "want to take" classes.
  const allCourseSections: Section[] = user
    ? [
        ...allEnrollments.map((e) => e.section),
        ...manualCourses.map((m) => manualPseudoSection(m, user.school)),
      ]
    : [];
  const settledSections: Section[] = user
    ? [
        ...allEnrollments.map((e) => e.section),
        ...manualCourses
          .filter((m) => !isPinnedPlan(m.kind))
          .map((m) => manualPseudoSection(m, user.school)),
      ]
    : [];
  const hasPlannedOnly = allCourseSections.length > settledSections.length;
  // setsForUser is request-cached, so the copy inside progressForUser is free.
  const [sets, progress, baseProgress] = await Promise.all([
    user ? setsForUser(user) : Promise.resolve([] as RequirementSet[]),
    user
      ? progressForUser(user, allCourseSections, assignments ? { assignments } : {})
      : Promise.resolve([] as SetProgress[]),
    user
      ? progressForUser(user, settledSections, assignments ? { assignments } : {})
      : Promise.resolve([] as SetProgress[]),
  ]);

  // The class whose "counts toward" boxes are being edited (🎯 in the course schedule).
  const countId = one(sp.count);
  const countCourse = user && countId ? allCourseSections.find((c) => c.id === countId) : undefined;
  const whatIfHref = `${selfHref}#whatif`;
  // A term cell's "+ plan a class" opens the Planned classes form for that term.
  const addTerm =
    /^(FA|SP|SU)\d{4}$/.test(one(sp.add)) && termSortKey(one(sp.add)) >= termSortKey(liveTerm) ? one(sp.add) : ""; // past terms can't be planned

  const notices = {
    ok: one(sp.ok),
    err: one(sp.err),
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <TermRemember term={term} />
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
            <AbroadPicker
              options={abroadOptions}
              marked={abroadTerms.map((id) => ({ id, label: termLabel(id) }))}
              defaultTerm={term}
              next={selfHref}
            />
          )}
        </div>
      </header>

      {!user && (
        <div className="card card-pad border-brand-200 bg-brand-50 text-sm text-brand-900">
          <strong>Just looking?</strong> The catalog and this grid are open to browse. When you
          add a course you&apos;ll be asked for your campus (no account needed) or to sign in — the
          course you picked comes along and is added to your plan automatically.
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
          hint={summary.crossCampus ? "taught at another campus" : "all home-campus"}
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

      {user && (
        <CourseHistory
          courses={history}
          abroadTerms={abroadTerms}
          school={user.school}
          currentTerm={liveTerm}
          syncedTerms={synced.map((t) => t.id)}
          next={selfHref}
          activeId={countCourse?.id}
          addPanel={
            addTerm ? (
              <>
              <ScrollOnMount id="plan-add" />
              <form
                id="plan-add"
                action={addManualCourseAction}
                className="scroll-mt-20 space-y-3 rounded-lg border border-brand-300 bg-brand-50/40 p-3"
              >
                <input type="hidden" name="kind" value="planned" />
                <input type="hidden" name="termId" value={addTerm} />
                <input type="hidden" name="next" value={selfHref} />
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold text-ink-900">Planned classes</h3>
                  <span className="text-xs text-ink-500">for {termLabel(addTerm)}</span>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-52 flex-1">
                    <label className="label" htmlFor="plan-title">Name</label>
                    <input id="plan-title" name="title" required placeholder="e.g. Biochemistry" className="input w-full" />
                  </div>
                  <div>
                    <label className="label" htmlFor="plan-credits">Credits ({schoolShort(user.school)})</label>
                    <input
                      id="plan-credits"
                      name="credits"
                      type="number"
                      required
                      min="0.25"
                      max="12"
                      step="0.25"
                      defaultValue={user.school === "HM" ? "3" : "1"}
                      className="input w-24"
                    />
                  </div>
                </div>
                <div>
                  <span className="label">What it counts for (shows in What if)</span>
                  <div className="mt-1">
                    <GroupCheckboxes
                      wide
                      sets={blankCountingSets(sets)}
                      checked={[]}
                      policy={overlapPolicyFor(user.school)}
                      pairUse={pairUseFrom(assignments ?? { sections: new Map(), manuals: new Map() }, sets, "", sections)}
                      strictGe={false}
                      advisorWarning={false}
                      creditsInput={{ name: "credits", perCourse: user.school === "HM" ? 3 : 1 }}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
                  <button type="submit" className="btn-primary text-xs">Add planned class</button>
                  <Link href={selfHref} className="btn-ghost text-xs">Cancel</Link>
                  <span className="text-xs text-ink-500">
                    To swap in a real class, add it from the catalog, or enter your own class manually below.
                  </span>
                </div>
              </form>
              </>
            ) : null
          }
        />
      )}

      {user && (
        <div className="grid gap-6 lg:grid-cols-12">
        <form id="manual-add" action={addManualCourseAction} className="card card-pad space-y-3 self-start scroll-mt-20 lg:col-span-7">
          {manualTerm && <ScrollOnMount id="manual-add" />}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-lg font-bold">Enter Course Manually</h2>
            <p className="max-w-3xl text-xs leading-relaxed text-ink-500">
              For classes that aren&apos;t in the catalog: a summer class, transfer credit, or a
              create-your-own designation. Studying abroad? Tick “studying abroad” at the top of
              the planner and pick the term — it gets a 🌍 label in your course schedule — then
              type that term&apos;s classes here.
            </p>
          </div>
          <input type="hidden" name="next" value={selfHref} />
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
              <label className="label" htmlFor="manual-term">
                Term
              </label>
              <select id="manual-term" name="termId" defaultValue={manualTerm || term} className="input w-auto">
                {manualTermChoices.map((t) => (
                  <option key={t} value={t}>
                    {termLabel(t)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="manual-credits">
                Credits ({schoolShort(user.school)})
              </label>
              <input
                id="manual-credits"
                type="number"
                name="credits"
                required
                min="0.25"
                max="12"
                step="0.25"
                defaultValue={user.school === "HM" ? "3" : "1"}
                className="input w-24"
              />
            </div>
            <div>
              <label className="label" htmlFor="manual-kind">
                Type
              </label>
              <select id="manual-kind" name="kind" defaultValue="credit" className="input w-auto">
                <option value="credit">🎓 Course Credit</option>
                <option value="transfer">📦 Transfer credit</option>
                <option value="custom">✏️ Create-your-own</option>
              </select>
            </div>
            <input
              type="text"
              name="note"
              placeholder="advisor note (optional)"
              className="input w-52 max-w-full text-xs"
            />
            <button type="submit" className="btn-primary">
              Add to my plan
            </button>
          </div>
          <div>
            <span className="label">
              Count it toward (optional — check every box it fills, the engine decides the rest)
            </span>
            <div className="mt-1">
              <GroupCheckboxes
                wide
                sets={blankCountingSets(sets)}
                checked={[]}
                policy={overlapPolicyFor(user?.school)}
                pairUse={pairUseFrom(assignments ?? { sections: new Map(), manuals: new Map() }, sets, "", sections)}
                strictGe={false}
                creditsInput={{ name: "credits", perCourse: user.school === "HM" ? 3 : 1 }}
              />
            </div>
          </div>
        </form>
          <section id="whatif" className="card card-pad space-y-3 scroll-mt-20 self-start lg:col-span-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold">What if</h2>
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
              <>
              {one(sp.wi) === "1" && (notices.ok || notices.err) && (
                <>
                  <ScrollOnMount id="whatif" />
                  <p
                    role="status"
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      notices.err
                        ? "border-red-300 bg-red-50 text-red-800"
                        : "border-emerald-300 bg-emerald-50 text-emerald-800"
                    }`}
                  >
                    {notices.err || notices.ok}
                  </p>
                </>
              )}
              <WhatIf
                base={baseProgress}
                whatIf={progress}
                hasPlanned={hasPlannedOnly}
                picker={
                  countCourse && user ? (
                    <>
                    <ScrollOnMount id="whatif" />
                    <form
                      action={saveCourseCounting}
                      className="space-y-3 rounded-lg border border-brand-300 bg-brand-50/40 p-3"
                    >
                      <input type="hidden" name="courseId" value={countCourse.id} />
                      <input type="hidden" name="courseKind" value={countCourse.manual ? "manual" : "section"} />
                      {/* Saving closes the picker (back to the What if card); a refused save keeps it open. */}
                      <input type="hidden" name="next" value={`${selfHref}&wi=1#whatif`} />
                      <input type="hidden" name="errNext" value={`${selfHref}&count=${encodeURIComponent(countCourse.id)}&wi=1#whatif`} />
                      <p className="text-sm font-semibold text-ink-900">
                        What will {countCourse.manual ? countCourse.title : countCourse.code_string.split(" · ")[0]} count for?
                      </p>
                      <p className="text-xs text-ink-600">
                        Tick every requirement it fills — the bars below update when you save. Leave it
                        blank to let the checklist decide.
                      </p>
                      {countCourse.manual && (
                        <div>
                          <label className="label" htmlFor="what-credits">
                            Credits ({schoolShort(user.school)})
                          </label>
                          <input
                            id="what-credits"
                            name="credits"
                            type="number"
                            min="0.25"
                            max="12"
                            step="0.25"
                            defaultValue={Number((countCourse.credits * (user.school === "HM" ? 3 : 1)).toFixed(2))}
                            className="input w-24"
                          />
                        </div>
                      )}
                      {(() => {
                        const list = countCourse.manual
                          ? (assignments?.manuals.get(countCourse.id) ?? [])
                          : (assignments?.sections.get(countCourse.id) ?? []);
                        const ids = list.map((a) => a.groupId);
                        return (
                          <GroupCheckboxes
                            key={ids.join(",")}
                            sets={countingSetsFor(sets, countCourse)}
                            checked={ids}
                            policy={overlapPolicyFor(user.school)}
                            pairUse={pairUseFrom(
                              assignments ?? { sections: new Map(), manuals: new Map() },
                              sets,
                              countCourse.id,
                              allCourseSections,
                            )}
                            strictGe={!countCourse.manual}
                            half={countCourse.credits_5c < 1}
                            advisorWarning={countCourse.manual?.kind !== "planned"}
                            creditsInput={countCourse.manual ? { name: "credits", perCourse: user.school === "HM" ? 3 : 1 } : undefined}
                          />
                        );
                      })()}
                      <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
                        <button type="submit" className="btn-primary text-xs">
                          Save &amp; update what-if
                        </button>
                        <button type="submit" name="release" value="1" className="btn-ghost text-xs">
                          ↩ Let the checklist decide
                        </button>
                        <Link href={whatIfHref} className="btn-ghost text-xs">
                          Close
                        </Link>
                      </div>
                    </form>
                    </>
                  ) : null
                }
              />
              </>
            )}
          </section>

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
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
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
                    {extractPrerequisites(s.description) && (
                      <p className="mt-1 text-xs leading-snug text-ink-600">
                        <span className="font-semibold text-amber-800">Prerequisites:</span>{" "}
                        <PrereqText text={extractPrerequisites(s.description)!} />
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <SeatsMeter s={s} />
                      <span
                        className={
                          s.perm_count > 0
                            ? "chip border-violet-300 bg-violet-50 text-violet-700"
                            : "chip border-ink-200 bg-ink-50 text-ink-500"
                        }
                        title="Perm seats the registrar lists for this section (cross-registration / permission-to-enroll)"
                      >
                        {s.perm_count} perm{s.perm_count === 1 ? "" : "s"}
                      </span>
                    </div>
                    {s.instructors.length > 0 && (
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600">
                        {s.instructors.map((i, idx) => (
                          <span key={i.id} className="inline-flex items-center gap-1">
                            <Link
                              href={`/professors/${encodeURIComponent(i.id)}`}
                              className="link inline-flex items-center gap-1"
                            >
                              {i.name}
                              <Stars value={i.avg_stars} hideEmpty />
                            </Link>
                            {idx < s.instructors.length - 1 && (
                              <span aria-hidden="true" className="-ml-1">
                                ,
                              </span>
                            )}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0">
                    <EnrollButton sectionId={s.id} inPlan={plannedIds.has(s.id)} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
                  <StatusSelect
                    id={`st-${e.id}`}
                    sectionId={s.id}
                    status={e.status === "waitlist" ? "planned" : e.status}
                    options={PLAN_STATUSES}
                  />
                  {(() => {
                    const on = e.status === "waitlist" || alertIds.has(s.id);
                    const full = s.seats_total > 0 && s.seats_filled >= s.seats_total;
                    // Offered on full classes; stays visible while ticked so it can be switched off.
                    return (e.status === "planned" || e.status === "perm_requested" || e.status === "waitlist") &&
                      (full || on) ? (
                      <SeatAlertToggle sectionId={s.id} on={on} />
                    ) : null;
                  })()}
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

        </div>

        {/* Right: grid + checklist */}
        <div className="space-y-6 lg:col-span-5">
          <section className="card card-pad space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold">Weekly grid</h2>
              <span className="text-xs text-ink-500">08:00 – 22:00</span>
            </div>
            {allSections.length ? (
              <Timetable sections={allSections} targetHeight={520} />
            ) : (
              <p className="text-sm text-ink-500">
                {abroad
                  ? "Enter this study-abroad term's courses by hand — they'll appear below the grid."
                  : "The grid fills in as you save courses."}
              </p>
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
