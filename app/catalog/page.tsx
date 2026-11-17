import Link from "next/link";
import { getSection, searchSections, facets, termsWithQuery } from "@/lib/catalog";
import { currentTermId } from "@/lib/ingest";
import { currentUser } from "@/lib/session";
import { enrolledSections, findConflicts } from "@/lib/schedule";
import { fulfillmentFor, setsForUser } from "@/lib/requirements";
import { SCHOOLS } from "@/lib/constants";
import { termLabel } from "@/lib/util";
import { SectionCard, type FitInfo } from "@/components/SectionCard";
import { Timetable } from "@/components/Timetable";
import { TermSelect } from "@/components/TermSelect";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

type SP = Record<string, string | string[] | undefined>;

function list(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  const raw = Array.isArray(v) ? v : [v];
  return raw
    .flatMap((x) => x.split(","))
    .map((x) => x.trim())
    .filter(Boolean);
}
function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}
function num(v: string | string[] | undefined): number | undefined {
  const n = Number(one(v));
  return one(v) !== "" && Number.isFinite(n) ? n : undefined;
}
/** Trim trailing zeros for credit totals, e.g. 12.50 -> "12.5". */
function cr(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** Rebuild a catalog URL with one key changed — used by sort/pagination links. */
function hrefFor(sp: SP, overrides: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  const merged: SP = { ...sp, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    // `term` must stay a single value: a duplicated term param (term=A&term=B)
    // used to serialize as "A,B" and silently matched nothing on every
    // generated Next/Previous link.
    const val = k === "term" ? (Array.isArray(v) ? v[0] ?? "" : v) : Array.isArray(v) ? v.join(",") : String(v);
    if (val === "") continue;
    q.set(k, val);
  }
  const s = q.toString();
  return `/catalog${s ? `?${s}` : ""}`;
}

export default async function CatalogPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await currentUser();

  const term = one(sp.term) || (await currentTermId());
  const page = Math.max(1, num(sp.page) ?? 1);
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

  const fx = await facets(term);
  const { rows, total } = await searchSections({
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
    offset: (page - 1) * PAGE_SIZE,
  });
  const sectionById = new Map(rows.map((r) => [r.id, r]));

  // When a plain query comes up empty in the selected term, point the user at
  // the terms that actually carry it (e.g. "bio 43LX" in a term without a lab).
  const otherTerms = total === 0 && q ? await termsWithQuery(q, term) : [];

  const planned = user ? await enrolledSections(user.id, term) : [];
  const plannedIds = new Set(planned.map((s) => s.id));
  const userSets = user ? await setsForUser(user) : [];

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

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
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
            <Link href="/requirements" className="btn-ghost">
              Browse to fill a checklist gap →
            </Link>
          )}
        </div>
      </form>

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

          {total === 0 ? (
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
            <div className="flex flex-col gap-3">
              {rows.map((s) => (
                <SectionCard
                  key={s.id}
                  s={s}
                  plannedIds={plannedIds}
                  fit={user ? fitFor(s.id) : undefined}
                  previewHref={user ? hrefFor(sp, { preview: s.id }) : undefined}
                  next={hrefFor(sp, {})}
                  reasons={
                    userSets.length
                      ? fulfillmentFor(s, userSets).map((f) => `${f.setName}: ${f.groupName}`)
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          {pages > 1 && (
            <nav className="flex flex-wrap items-center justify-between gap-2 pt-2" aria-label="Pagination">
              <span className="text-sm text-ink-500">
                Page {page} of {pages} · showing {rows.length} of {total.toLocaleString()}
              </span>
              <div className="flex gap-1">
                {page > 1 && (
                  <Link href={hrefFor(sp, { page: String(page - 1) })} className="btn-secondary">
                    ← Previous
                  </Link>
                )}
                {page < pages && (
                  <Link href={hrefFor(sp, { page: String(page + 1) })} className="btn-secondary">
                    Next →
                  </Link>
                )}
              </div>
            </nav>
          )}
        </div>

        {/* Right: the student's live weekly grid for this term, sticky while browsing */}
        {user && (
          <aside className="min-w-0 lg:sticky lg:top-4 lg:col-span-5" aria-label="Your weekly grid">
            <div className="card card-pad space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-bold tracking-tight">
                  Your {termLabel(term)} grid
                </h2>
                <Link href={`/planner?term=${term}`} className="link text-xs">
                  Open planner →
                </Link>
              </div>
              {planned.length ? (
                <>
                  <Timetable sections={planned} />
                  <p className="text-xs text-ink-500">
                    {planned.length} saved course{planned.length === 1 ? "" : "s"} ·{" "}
                    {cr(planned.reduce((a, s) => a + s.credits_5c, 0))} 5C credits. Use{" "}
                    <span className="font-semibold">View on grid</span> on any class to see where
                    it lands — a conflict is flagged before you save it.
                  </p>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-ink-500">
                  Nothing saved for {termLabel(term)} yet. As you add courses they appear here,
                  side by side with the catalog, so you can build the whole week at a glance.
                </p>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
