import Link from "next/link";
import { all, get } from "@/lib/db";
import { SCHOOLS, SCHOOL_BY_CODE } from "@/lib/constants";
import { schoolShort } from "@/lib/util";
import { Stars } from "@/components/Stars";
import { RmpScore } from "@/components/RmpScore";

export const dynamic = "force-dynamic";

export const metadata = { title: "Professors" };

const PAGE_SIZE = 30;

/** `instructor_ratings` (lib/schema.sql) joined with the instructor's home campus. */
type Row = {
  id: string;
  name: string;
  home_school: string | null;
  section_count: number | null;
  review_count: number | null;
  avg_stars: number | null;
  rmp_quality: number | null;
  rmp_difficulty: number | null;
  rmp_num_ratings: number | null;
  rmp_url: string | null;
};

type SP = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}

/** Whitelisted ORDER BY clauses — user input never reaches the SQL string. */
const SORTS: Record<string, { label: string; short: string; order: string }> = {
  name: { label: "Name (A–Z)", short: "Name", order: "ir.name ASC" },
  stars: {
    label: "Our stars (high → low)",
    short: "Our stars",
    order: "ir.avg_stars IS NULL, ir.avg_stars DESC, ir.review_count DESC, ir.name ASC",
  },
  rmp: {
    label: "RateMyProfessors (high → low)",
    short: "RMP",
    order: "ir.rmp_quality IS NULL, ir.rmp_quality DESC, ir.rmp_num_ratings DESC, ir.name ASC",
  },
  courses: {
    label: "Most sections taught",
    short: "Courses",
    order: "ir.section_count DESC, ir.name ASC",
  },
};

/** node:sqlite hands us numbers; keep null/NaN out of the render path. */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Quote LIKE wildcards so a literal "%" searches for "%". */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildFilters(sp: SP) {
  const q = one(sp.q);
  const sort = SORTS[one(sp.sort)] ? one(sp.sort) : "name";
  const rawSchool = one(sp.school).toUpperCase();
  const school = SCHOOLS.some((s) => s.code === rawSchool) ? rawSchool : "";
  const page = Math.max(1, Number(one(sp.page)) || 1);

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push(`ir.name LIKE ? ESCAPE '\\'`);
    params.push(likeTerm(q));
  }
  if (school) {
    where.push("i.home_school = ?");
    params.push(school);
  }
  return { q, sort, school, page, where, params };
}

/** Rebuild the directory URL with one key changed (sort + pagination links). */
function hrefFor(sp: SP, overrides: Record<string, string | undefined>) {
  const merged: SP = { ...sp, ...overrides };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = qs.toString();
  return `/professors${s ? `?${s}` : ""}`;
}

function CampusBadge({ code }: { code: string | null }) {
  const s = code ? SCHOOL_BY_CODE[code] : undefined;
  if (!s) {
    return (
      <span className="chip border-ink-200 bg-ink-50 text-ink-400" title="Campus not recorded">
        5C
      </span>
    );
  }
  return (
    <span
      className="chip"
      style={{
        borderColor: `color-mix(in srgb, ${s.accent} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${s.accent} 8%, transparent)`,
        color: s.accent,
      }}
      title={s.name}
    >
      {s.short}
    </span>
  );
}

export default async function ProfessorsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { q, sort, school, page, where, params } = buildFilters(sp);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `FROM instructor_ratings ir JOIN instructors i ON i.id = ir.id`;

  const total = Number(
    (await get<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${clause}`, params))?.n ?? 0,
  );
  const known = Number(
    (await get<{ n: number }>("SELECT COUNT(*) AS n FROM instructor_ratings"))?.n ?? 0,
  );

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shown = Math.min(page, pages); // a too-large ?page= must not render an empty list

  const rows = await all<Row>(
    `SELECT ir.id, ir.name, ir.section_count, ir.review_count, ir.avg_stars,
            ir.rmp_quality, ir.rmp_difficulty, ir.rmp_num_ratings, ir.rmp_url,
            i.home_school
     ${from} ${clause}
     ORDER BY ${SORTS[sort].order}
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, (shown - 1) * PAGE_SIZE],
  );

  const filtered = Boolean(q || school);
  const sortHref = (key: string) => hrefFor(sp, { sort: key, page: undefined });

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
        <p className="text-sm text-ink-500">
          <strong className="text-ink-800 tabular-nums">{known.toLocaleString()}</strong> professors
          in the catalog
        </p>
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
              } · page ${shown} of ${pages}`}
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
        <>
          {/* table on sm and up */}
          <div className="card hidden overflow-hidden sm:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50 text-left text-[11px] uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2.5 font-semibold">Professor</th>
                  <th className="px-2 py-2.5 font-semibold">Campus</th>
                  <th className="px-2 py-2.5 text-right font-semibold">Sections</th>
                  <th className="px-2 py-2.5 font-semibold">Our students</th>
                  <th className="px-2 py-2.5 font-semibold">Review</th>
                  <th className="px-4 py-2.5 font-semibold">RateMyProfessors</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/professors/${encodeURIComponent(r.id)}`}
                        className="font-semibold text-ink-900 hover:underline"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-2 py-2.5">
                      <CampusBadge code={r.home_school} />
                    </td>
                    <td className="px-2 py-2.5 text-right text-ink-600 tabular-nums">
                      {r.section_count ?? 0}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Stars
                          value={num(r.avg_stars)}
                          href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                          title="View written reviews"
                        />
                        <Link
                          href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                          className="text-[11px] text-ink-400 hover:text-ink-700 hover:underline"
                        >
                          {r.review_count ?? 0} review{(r.review_count ?? 0) === 1 ? "" : "s"}
                        </Link>
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <Link
                        href={`/professors/${encodeURIComponent(r.id)}#write-review`}
                        className="btn-ghost px-2 py-1 text-xs"
                        title="Write an anonymous review (one per account, editable later)"
                      >
                        Write one
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <RmpScore
                        name={r.name}
                        schoolCode={r.home_school}
                        quality={num(r.rmp_quality)}
                        difficulty={num(r.rmp_difficulty)}
                        numRatings={num(r.rmp_num_ratings)}
                        url={r.rmp_url}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* stacked cards below sm */}
          <ul className="space-y-3 sm:hidden">
            {rows.map((r) => (
              <li key={r.id} className="card card-pad">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Link
                    href={`/professors/${encodeURIComponent(r.id)}`}
                    className="text-base font-semibold text-ink-900 hover:underline"
                  >
                    {r.name}
                  </Link>
                  <CampusBadge code={r.home_school} />
                </div>
                <div className="mt-2 space-y-1.5 text-sm">
                  <div className="flex items-center gap-1.5">
                    <Stars
                      value={num(r.avg_stars)}
                      href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                      title="View written reviews"
                    />
                    <Link
                      href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                      className="text-[11px] text-ink-400 hover:text-ink-700 hover:underline"
                    >
                      {r.review_count ?? 0} review{(r.review_count ?? 0) === 1 ? "" : "s"}
                    </Link>
                    <Link
                      href={`/professors/${encodeURIComponent(r.id)}#write-review`}
                      className="btn-ghost px-2 py-0.5 text-[11px]"
                    >
                      Write one
                    </Link>
                  </div>
                  <div>
                    <span className="text-[11px] uppercase tracking-wide text-ink-400">
                      RateMyProfessors
                    </span>
                    <RmpScore
                      className="mt-0.5"
                      name={r.name}
                      schoolCode={r.home_school}
                      quality={num(r.rmp_quality)}
                      difficulty={num(r.rmp_difficulty)}
                      numRatings={num(r.rmp_num_ratings)}
                      url={r.rmp_url}
                    />
                  </div>
                  <p className="text-xs text-ink-500">
                    <Link href={`/professors/${encodeURIComponent(r.id)}`} className="link">
                      Full profile
                    </Link>
                    {" · "}
                    {r.section_count ?? 0} section{(r.section_count ?? 0) === 1 ? "" : "s"} taught
                  </p>
                </div>
              </li>
            ))}
          </ul>

          {/* ------------------------------ pagination ---------------------------- */}
          {pages > 1 ? (
            <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Pagination">
              <span className="text-xs text-ink-500">
                Showing {(shown - 1) * PAGE_SIZE + 1}–{Math.min(shown * PAGE_SIZE, total)} of{" "}
                {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                {shown > 1 ? (
                  <Link href={hrefFor(sp, { page: String(shown - 1) })} className="btn-secondary">
                    ← Prev
                  </Link>
                ) : (
                  <span className="btn-secondary pointer-events-none opacity-40">← Prev</span>
                )}
                <span className="px-2 text-sm text-ink-600 tabular-nums">
                  {shown} / {pages}
                </span>
                {shown < pages ? (
                  <Link href={hrefFor(sp, { page: String(shown + 1) })} className="btn-secondary">
                    Next →
                  </Link>
                ) : (
                  <span className="btn-secondary pointer-events-none opacity-40">Next →</span>
                )}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
