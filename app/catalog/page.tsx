import Link from "next/link";
import { cookies } from "next/headers";
import { getSection, searchSections, facets, termsWithQuery } from "@/lib/catalog";
import { currentTermId } from "@/lib/ingest";
import { currentUser } from "@/lib/session";
import { enrolledSections, findConflicts } from "@/lib/schedule";
import { fulfillmentFor, setsForUser } from "@/lib/requirements";
import { SCHOOLS } from "@/lib/constants";
import { formatCredits, formatMeeting, termLabel } from "@/lib/util";
import { findGapFillers, type GapResult } from "@/lib/gapfill";
import { refreshInBackground } from "@/lib/refresh";
import { preferredTerm } from "@/lib/term-pref";
import { TermRemember } from "@/components/TermRemember";
import type { RequirementSet, Section } from "@/lib/types";
import { SectionCard, type FitInfo } from "@/components/SectionCard";
import { Timetable } from "@/components/Timetable";
import { InfiniteSections } from "@/components/InfiniteSections";
import { SectionCards } from "@/components/SectionCards";
import { hrefFor, list, num, one, cr, queryFromSp, type SP } from "@/lib/catalog-params";
import { AutoHideBar } from "@/components/AutoHideBar";
import { LiveGrid } from "@/components/LiveGrid";
import { PreviewCard } from "@/components/PreviewCard";
import { CatalogGridProvider } from "@/components/CatalogGridProvider";
import { toGridSection } from "@/lib/grid-blocks";
import { TermSelect } from "@/components/TermSelect";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24; // first batch; more load as you scroll

export default async function CatalogPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await currentUser();

  const term = one(sp.term) || (await preferredTerm()) || (await currentTermId());
  refreshInBackground(term); // seats / perms / times: re-check the live feed after responding
  const q = one(sp.q);
  const schools = list(sp.school);
  const depts = list(sp.dept);
  const areas = list(sp.area);
  const instructor = one(sp.instructor);
  const sort = one(sp.sort) || "code";
  const openOnly = one(sp.open) === "1";
  const permOnly = one(sp.perm) === "1";
  const notAtSchool = one(sp.notAt) === "1" ? (user?.school ?? "") : "";
  const minCredits = num(sp.minCredits);
  const maxCredits = num(sp.maxCredits);
  const previewId = one(sp.preview);
  const fill = Boolean(user) && one(sp.fill) === "1";

  // All four are independent once `term` is known — one parallel fan-out
  // (they used to be ~10 serial Turso round-trips).
  const [fx, { rows, total }, planned, userSets, gap] = await Promise.all([
    facets(term),
    fill
      ? Promise.resolve({ rows: [] as Section[], total: 0 })
      : searchSections({
      q: q || undefined,
      term,
      schools,
      departments: depts,
      areas,
      instructor: instructor || undefined,
      minCredits,
      maxCredits,
      openOnly,
      permOnly,
      notAtSchool: notAtSchool || undefined,
      sort: sort as "code" | "title" | "credits" | "perm",
      limit: PAGE_SIZE,
      offset: 0,
    }),
    user ? enrolledSections(user.id, term) : Promise.resolve([] as Section[]),
    user ? setsForUser(user) : Promise.resolve([] as RequirementSet[]),
    fill && user
      ? cookies().then((jar) =>
          findGapFillers(user, term, 24, (jar.get("gapkeep")?.value ?? "").split(",").filter(Boolean)),
        )
      : Promise.resolve(null as GapResult | null),
  ]);
  const sectionById = new Map([...rows, ...(gap?.picks.map((g) => g.section) ?? [])].map((r) => [r.id, r]));

  // When a plain query comes up empty in the selected term, point the user at
  // the terms that actually carry it (e.g. "bio 43LX" in a term without a lab).
  const otherTerms = !fill && total === 0 && q ? await termsWithQuery(q, term) : [];

  const plannedIds = new Set(planned.map((s) => s.id));

  /** Does this section clash with the student's saved classes for the term? */
  const fitFor = (sId: string): FitInfo | undefined => {
    if (!user) return undefined;
    if (plannedIds.has(sId)) return { state: "planned" };
    if (planned.length === 0) return { state: "empty" };
    const s = sectionById.get(sId)!;
    const clashes = findConflicts([...planned, s]).filter(
      (c) => c.a.id === sId || c.b.id === sId,
    );
    return clashes.length
      ? {
          state: "conflict",
          n: planned.length,
          with: clashes.map((c) => (c.a.id === sId ? c.b : c.a).code_string),
        }
      : { state: "fits", n: planned.length };
  };

  // Weekly-grid preview: the section the student clicked "View on grid" on,
  // drawn together with everything already saved for that term.
  const previewSection = user && previewId ? await getSection(previewId) : undefined;
  let previewCtx: { base: Awaited<ReturnType<typeof enrolledSections>>; clashes: ReturnType<typeof findConflicts> } | undefined;
  if (user && previewSection) {
    const base = (await enrolledSections(user.id, previewSection.term_id)).filter(
      (s) => s.id !== previewSection.id,
    );
    previewCtx = {
      base,
      clashes: findConflicts([...base, previewSection]).filter(
        (c) => c.a.id === previewSection.id || c.b.id === previewSection.id,
      ),
    };
  }

  const activeFilters =
    (q ? 1 : 0) +
    schools.length +
    depts.length +
    areas.length +
    (instructor ? 1 : 0) +
    (openOnly ? 1 : 0) +
    (permOnly ? 1 : 0) +
    (notAtSchool ? 1 : 0) +
    (minCredits !== undefined ? 1 : 0) +
    (maxCredits !== undefined ? 1 : 0);

  return (
    <div className="flex flex-col gap-5">
      <TermRemember term={term} />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Course catalog</h1>
          <p className="mt-1 text-sm text-ink-600">
            {total.toLocaleString()} section{total === 1 ? "" : "s"} in{" "}
            <strong>{termLabel(term)}</strong> across the 5Cs — updated as the registrar publishes.
          </p>
        </div>
      </header>

      {one(sp.err) && (
        <div className="card card-pad border-red-300 bg-red-50 text-sm text-red-800">{one(sp.err)}</div>
      )}
      {one(sp.ok) && (
        <div className="card card-pad border-emerald-300 bg-emerald-50 text-sm text-emerald-800">
          {one(sp.ok)}
        </div>
      )}

      {/* Filters submit as a plain GET form, so this page works with no JS. */}
      <AutoHideBar>
      <form id="catalog-filters" method="get" action="/catalog" className="card card-pad">
        <div className="grid gap-3 md:grid-cols-12">
          <div className="md:col-span-4">
            <label className="label" htmlFor="q">
              Search
            </label>
            <input
              id="q"
              name="q"
              defaultValue={q}
              className="input"
              placeholder="chem, chem 014L, dance 152, math58, graph theory…"
            />
          </div>
          <div className="md:col-span-3">
            <label className="label" htmlFor="instructor">
              Professor
            </label>
            <input
              id="instructor"
              name="instructor"
              defaultValue={instructor}
              className="input"
              placeholder="last name"
            />
          </div>
          <div className="md:col-span-3">
            <label className="label" htmlFor="term">
              Term
            </label>
            {/* Auto-submits on change, so results + the weekly grid switch to
                the picked term (the "Apply filters" button covers no-JS). */}
            <TermSelect options={fx.terms.map((t) => ({ ...t }))} value={term} className="input" />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="sort">
              Sort
            </label>
            <select id="sort" name="sort" defaultValue={sort} className="input">
              <option value="code">Course code</option>
              <option value="title">Title</option>
              <option value="credits">Credits</option>
              <option value="perm">Perm seats</option>
            </select>
          </div>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-12">
          <fieldset className="md:col-span-4">
            <legend className="label">Teaching campus</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {SCHOOLS.map((s) => (
                <label key={s.code} className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="school"
                    value={s.code}
                    defaultChecked={schools.includes(s.code)}
                    className="h-3.5 w-3.5 accent-brand-600"
                  />
                  {s.short}
                  <span className="text-xs text-ink-400">
                    {fx.schools.find((x) => x.code === s.code)?.n ?? 0}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="md:col-span-4">
            <label className="label" htmlFor="dept">
              Department {depts.length ? `(=${depts.join(", ")})` : ""}
            </label>
            <input
              id="dept"
              name="dept"
              defaultValue={depts.join(",")}
              className="input font-mono text-xs"
              placeholder="CSCI,MATH,ECON"
              list="dept-list"
            />
            <datalist id="dept-list">
              {fx.departments.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.description}
                </option>
              ))}
            </datalist>
          </div>

          <div className="md:col-span-2">
            <label className="label" htmlFor="minCredits">
              Credits
            </label>
            <div className="flex items-center gap-1">
              <input
                id="minCredits"
                name="minCredits"
                type="number"
                step="0.25"
                min="0"
                defaultValue={minCredits ?? ""}
                className="input"
                placeholder="min"
              />
              <input
                name="maxCredits"
                type="number"
                step="0.25"
                min="0"
                defaultValue={maxCredits ?? ""}
                className="input"
                placeholder="max"
                aria-label="Maximum credits"
              />
            </div>
          </div>

          <fieldset className="md:col-span-2">
            <legend className="label">Quick filters</legend>
            <div className="flex flex-col gap-1 text-sm">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="open"
                  value="1"
                  defaultChecked={openOnly}
                  className="h-3.5 w-3.5 accent-brand-600"
                />
                Open only
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="perm"
                  value="1"
                  defaultChecked={permOnly}
                  className="h-3.5 w-3.5 accent-brand-600"
                />
                Has perm seats
              </label>
              <label className="inline-flex items-center gap-1.5" title="Cross-registration shopping">
                <input
                  type="checkbox"
                  name="notAt"
                  value="1"
                  defaultChecked={Boolean(notAtSchool)}
                  className="h-3.5 w-3.5 accent-brand-600"
                  disabled={!user}
                />
                Off-campus{user ? ` (not ${user.school})` : ""}
              </label>
            </div>
          </fieldset>
        </div>

        {areas.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-ink-500">Course areas:</span>
            {areas.map((a) => (
              <Link
                key={a}
                href={hrefFor(sp, { area: areas.filter((x) => x !== a).join(",") || undefined, page: undefined })}
                className="chip border-teal-300 bg-teal-50 text-teal-800"
                title="Remove filter"
              >
                {a} ✕
              </Link>
            ))}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary">
            Apply filters
          </button>
          {activeFilters > 0 && (
            <Link href={`/catalog?term=${term}`} className="btn-secondary">
              Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}
            </Link>
          )}
          {user && (
            <Link href={`/catalog?term=${encodeURIComponent(term)}&fill=1`} className="btn-ghost">
              Find classes for my empty time slots →
            </Link>
          )}
        </div>
      </form>
      </AutoHideBar>

      <CatalogGridProvider term={term}>
      <div className="grid items-start gap-5 lg:grid-cols-12">
        {/* Left: search results */}
        <div className="min-w-0 space-y-3 lg:col-span-7">
          {previewSection && previewCtx && (
            <section className="card card-pad space-y-3" aria-label="Weekly grid preview">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-bold tracking-tight">
                  Where <span className="font-mono text-base">{previewSection.code_string}</span>{" "}
                  lands on your {termLabel(previewSection.term_id)} grid
                </h2>
                <Link href={hrefFor(sp, { preview: undefined })} className="link text-sm">
                  Close preview ✕
                </Link>
              </div>
              {previewCtx.clashes.length > 0 ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  ⚠ Time conflict with{" "}
                  {previewCtx.clashes
                    .map((c) => (c.a.id === previewSection.id ? c.b : c.a).code_string)
                    .join(", ")}{" "}
                  ({previewCtx.clashes.map((c) => c.days).join(", ")}). A different section number
                  of the same course usually fixes it.
                </div>
              ) : (
                <p className="text-sm font-medium text-emerald-800">
                  ✓ No time overlap with your {previewCtx.base.length} saved{" "}
                  {termLabel(previewSection.term_id)} course{previewCtx.base.length === 1 ? "" : "s"}.
                </p>
              )}
              <Timetable sections={[...previewCtx.base, previewSection]} />
            </section>
          )}

          {fill && gap ? (
            <>
              <section className="card card-pad space-y-1" aria-label="Classes for your empty time slots">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-bold tracking-tight">
                    Classes that fit your {termLabel(term)} grid
                  </h2>
                  <Link href={`/catalog?term=${encodeURIComponent(term)}`} className="link text-sm">
                    Show all classes ✕
                  </Link>
                </div>
                <p className="text-sm leading-relaxed text-ink-600">
                  {gap.plannedCount > 0
                    ? `Each class below meets only in empty slots next to your ${gap.plannedCount} saved class${gap.plannedCount === 1 ? "" : "es"}`
                    : "Your grid is empty, so every time works"}{" "}
                  and advances a requirement you still need — <strong>major and minor</strong>{" "}
                  requirements first, then <strong>general education</strong>. One section per
                  course; open classes rank a little higher.
                </p>
              </section>
              {gap.picks.length === 0 ? (
                <div className="card card-pad text-center">
                  <p className="font-semibold">
                    {gap.openGroups === 0
                      ? "No open requirements left to fill."
                      : "Nothing this term fits your empty slots and an open requirement."}
                  </p>
                  <p className="mt-1 text-sm text-ink-600">
                    {gap.openGroups === 0
                      ? "Every checklist box that has a fixed requirement is already satisfied."
                      : "Try another term, or open the planner to free up a time slot."}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {gap.picks.map((pick) => (
                    <PreviewCard
                      key={pick.section.id}
                      section={toGridSection(pick.section)}
                      inPlan={plannedIds.has(pick.section.id)}
                    >
                    <SectionCard
                      s={pick.section}
                      plannedIds={plannedIds}
                      fit={fitFor(pick.section.id)}
                      next={hrefFor(sp, {})}
                      fromFill
                      needTag={{
                        tier: pick.tier,
                        label:
                          pick.tier === "ge"
                            ? "Fills a GE you need"
                            : pick.tier === "major"
                              ? "Fills a major requirement"
                              : "Fills a minor requirement",
                      }}
                      reasons={pick.reasons}
                    />
                    </PreviewCard>
                  ))}
                </div>
              )}
            </>
          ) : total === 0 ? (
            <div className="card card-pad text-center">
              <p className="font-semibold">Nothing matched.</p>
              {q && otherTerms.length > 0 ? (
                <p className="mt-1 text-sm text-ink-600">
                  No “{q}” in {termLabel(term)}, but it is offered in:{" "}
                  {otherTerms.map((t, i) => (
                    <span key={t.term_id}>
                      {i > 0 && ", "}
                      <Link
                        className="font-medium text-sky-700 underline"
                        href={`/catalog?q=${encodeURIComponent(q)}&term=${encodeURIComponent(t.term_id)}`}
                      >
                        {termLabel(t.term_id)} ({t.n})
                      </Link>
                    </span>
                  ))}
                  .
                </p>
              ) : (
                <p className="mt-1 text-sm text-ink-600">
                  {fx.terms.length === 0
                    ? "The catalog hasn't synced yet — check back soon."
                    : "Try fewer filters, or a different term."}
                </p>
              )}
            </div>
          ) : (
            <InfiniteSections
              // New filters => new list: remount so the appended batches reset.
              key={`${term}|${JSON.stringify(sp)}`}
              first={
                <SectionCards rows={rows} sp={sp} signedIn={!!user} planned={planned} userSets={userSets} />
              }
              firstCount={rows.length}
              total={total}
              sp={Object.fromEntries(
                Object.entries(sp).flatMap(([k, v]) =>
                  v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v]],
                ),
              )}
              term={term}
            />
          )}
        </div>

        {/* Right: the student's live weekly grid for this term, sticky while browsing */}
        {user && (
          <aside
            className="min-w-0 lg:sticky lg:top-4 lg:col-span-5 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:overscroll-contain"
            aria-label="Your weekly grid"
          >
            <LiveGrid
              term={term}
              termName={termLabel(term)}
              planned={planned.map(toGridSection)}
              items={planned.map((s) => ({
                id: s.id,
                code: s.code_string,
                title: s.title,
                credits: formatCredits(s.credits, s.school),
                meetings: s.meetings.map((m) => formatMeeting(m)),
                instructors: s.instructors.map((i) => i.name).join(", "),
              }))}
              credits={cr(planned.reduce((a, s) => a + s.credits_5c, 0))}
            />
          </aside>
        )}
      </div>
      </CatalogGridProvider>
    </div>
  );
}
