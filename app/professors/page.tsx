import Link from "next/link";
import { get } from "@/lib/db";
import { SCHOOLS } from "@/lib/constants";
import { schoolShort } from "@/lib/util";
import { SORTS, buildFilters, fetchProfessors, one, type SP } from "@/lib/professors-list";
import { InfiniteProfessors } from "@/components/InfiniteProfessors";
import { ProfessorLis, ProfessorTrs } from "@/components/ProfessorRows";

export const dynamic = "force-dynamic";

export const metadata = { title: "Professors" };

const PAGE_SIZE = 30; // first batch; more load as you scroll

export default async function ProfessorsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { q, sort, school } = buildFilters(sp);
  const { rows, total, ayLabel, ayTitle } = await fetchProfessors(sp, 0, PAGE_SIZE);
  const known = Number(
    (await get<{ n: number }>("SELECT COUNT(*) AS n FROM instructor_ratings"))?.n ?? 0,
  );

  const filtered = Boolean(q || school);
  const sortHref = (key: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, sort: key })) {
      if (v === undefined || v === "" || k === "page") continue;
      qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return `/professors?${qs.toString()}`;
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Professors</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-600">
            Star ratings and written reviews are contributed by 5Cycle students. The RateMyProfessors
            column is mirrored third-party data and is always labelled — where we have no mirrored
            score we link out rather than estimate one.
          </p>
        </div>
        <div className="text-right text-sm text-ink-500">
          <p>
            <strong className="text-ink-800 tabular-nums">{known.toLocaleString()}</strong> professors
            in the catalog
          </p>
          <Link href="/reviews" className="link text-xs">
            Read every student review →
          </Link>
        </div>
      </header>

      {/* ------------------------------ filter bar ------------------------------ */}
      <form method="get" action="/professors" className="card card-pad">
        <div className="grid gap-3 sm:grid-cols-[2fr_1.4fr_1.2fr_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="q">
              Search name
            </label>
            <input
              id="q"
              className="input"
              type="search"
              name="q"
              defaultValue={q}
              placeholder="e.g. Ramirez"
            />
          </div>

          <div>
            <label className="label" htmlFor="sort">
              Sort by
            </label>
            <select id="sort" className="input" name="sort" defaultValue={sort}>
              {Object.entries(SORTS).map(([key, v]) => (
                <option key={key} value={key}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="school">
              Campus
            </label>
            <select id="school" className="input" name="school" defaultValue={school}>
              <option value="">All 5C campuses</option>
              {SCHOOLS.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short} — {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <button type="submit" className="btn-primary">
              Apply
            </button>
            {filtered ? (
              <Link href="/professors" className="btn-secondary">
                Clear
              </Link>
            ) : null}
          </div>
        </div>
        <p className="mt-3 text-xs text-ink-500">
          {total === 0
            ? "No matches"
            : `${total.toLocaleString()} ${total === 1 ? "professor" : "professors"}${
                filtered ? " match your filters" : ""
              }`}
          <span className="hidden sm:inline"> · sort:</span>
          {Object.keys(SORTS).map((key) => (
            <Link
              key={key}
              href={sortHref(key)}
              className={
                key === sort
                  ? "ml-1 text-ink-800 underline underline-offset-2"
                  : "ml-1 text-brand-600 hover:underline"
              }
            >
              {SORTS[key].short}
            </Link>
          ))}
        </p>
      </form>

      {/* -------------------------------- results ------------------------------- */}
      {rows.length === 0 ? (
        known === 0 ? (
          <div className="card card-pad text-center">
            <h2 className="text-base font-semibold text-ink-800">No professors yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-600">
              This page is built from the course catalog: professors appear as sections are synced.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Link href="/catalog" className="btn-primary">
                Browse courses
              </Link>
            </div>
          </div>
        ) : (
          <div className="card card-pad text-center">
            <h2 className="text-base font-semibold text-ink-800">
              {q ? (
                <>
                  Nobody matches <span className="font-mono">“{q}”</span>
                  {school ? ` at ${schoolShort(school)}` : ""}
                </>
              ) : (
                <>No professors at {schoolShort(school)}</>
              )}
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-600">
              Search matches the full name as the registrar lists it. Try a shorter fragment, or drop
              the filters and browse everything.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Link href="/professors" className="btn-secondary">
                Clear all filters
              </Link>
              <Link href={`/catalog?instructor=${encodeURIComponent(q)}`} className="btn-secondary">
                Search courses instead
              </Link>
            </div>
          </div>
        )
      ) : (
        <InfiniteProfessors
          // New filters / sort => a fresh list.
          key={JSON.stringify(sp)}
          firstTrs={<ProfessorTrs rows={rows} />}
          firstLis={<ProfessorLis rows={rows} ayLabel={ayLabel} />}
          firstCount={rows.length}
          total={total}
          sp={Object.fromEntries(
            Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v]])),
          )}
          ayLabel={ayLabel}
          ayTitle={ayTitle}
        />
      )}
    </div>
  );
}
