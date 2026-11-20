/**
 * Four-year course schedule (like the advising spreadsheet): one row per
 * academic year, Fall / Spring / Summer columns, every class the student has
 * saved or entered — past terms marked as taken.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { removeManualCourseAction } from "@/actions/requirements";
import { cn, termLabel } from "@/lib/util";

export type HistoryCourse = {
  id: string;
  code: string;
  title: string;
  credits: number;
  /** "FA2025" etc., or null when the term can't be placed on the grid. */
  termId: string | null;
  termLabel: string;
  manual: boolean;
  glyph?: string;
};

const SEASONS = [
  { key: "FA", label: "Fall" },
  { key: "SP", label: "Spring" },
  { key: "SU", label: "Summer" },
] as const;

/** Chronological order key: SP < SU < FA within a calendar year. */
function termKey(id: string): number {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(id);
  if (!m) return 0;
  return Number(m[2]) * 10 + (m[1] === "SP" ? 1 : m[1] === "SU" ? 2 : 3);
}
const yearStartOf = (id: string): number => {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(id)!;
  return m[1] === "FA" ? Number(m[2]) : Number(m[2]) - 1;
};
const isPlan = (c: HistoryCourse) => c.manual && c.glyph === "📌";
const cr = (n: number) => String(Number(n.toFixed(2)));

/** Inside a term cell. Future / current terms: "+ plan a class". A past term can't be planned: add the class from the catalog or enter it manually. */
function AddHere({ id, next, past, synced }: { id: string; next: string; past: boolean; synced: boolean }) {
  const sep = next.includes("?") ? "&" : "?";
  if (!past) {
    return (
      <a
        href={`${next}${sep}add=${id}#plan-add`}
        className="block text-ink-400 hover:text-brand-700"
        title={`Plan a class for ${termLabel(id)}`}
      >
        + plan a class
      </a>
    );
  }
  return (
    <div className="space-y-0.5 text-ink-400">
      {synced && (
        <Link href={`/catalog?term=${id}`} className="block hover:text-brand-700" title={`Add a class from the ${termLabel(id)} catalog`}>
          + add in catalog
        </Link>
      )}
      <a
        href={`${next}${sep}manual=${id}#manual-add`}
        className="block hover:text-brand-700"
        title={`Enter a ${termLabel(id)} class by hand`}
      >
        + add manually
      </a>
    </div>
  );
}

export function CourseHistory({
  courses,
  currentTerm,
  syncedTerms,
  next,
  abroadTerms = [],
  school,
  activeId,
  addPanel,
}: {
  courses: HistoryCourse[];
  currentTerm: string;
  syncedTerms: string[];
  /** Where the add / remove forms return to. */
  next: string;
  /** Terms marked study abroad: labelled in the grid. */
  abroadTerms?: string[];
  /** Student's home campus: credits are entered on its scale. */
  school: string;
  /** The class whose counting boxes are open in the What-if card. */
  activeId?: string;
  /** The "Planned classes" form, shown above the table when a cell's + plan a class is clicked. */
  addPanel?: ReactNode;
}) {
  const placed = courses.filter((c) => c.termId && /^(FA|SP|SU)\d{4}$/.test(c.termId));
  const loose = courses.filter((c) => !placed.includes(c));

  const years = [
    ...placed.map((c) => yearStartOf(c.termId!)),
    ...(currentTerm ? [yearStartOf(currentTerm)] : []),
  ];
  const first = years.length ? Math.min(...years) : new Date().getFullYear();
  const last = Math.max(first + 3, ...years); // at least four years
  const rows: number[] = [];
  for (let y = first; y <= last; y++) rows.push(y);

  const cellTerm = (y: number, season: string) => (season === "FA" ? `FA${y}` : `${season}${y + 1}`);
  const cur = currentTerm ? termKey(currentTerm) : 0;
  const synced = new Set(syncedTerms);
  const totalCredits = courses.reduce((a, c) => a + c.credits, 0);

  return (
    <section aria-label="Course schedule" className="card card-pad space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">Course schedule</h2>
        <p className="text-xs text-ink-500">
          {courses.length} course{courses.length === 1 ? "" : "s"} · {cr(totalCredits)} credits ·{" "}
          <span className="text-emerald-700">✓ = past term</span> ·{" "}
          <Link href="/requirements" className="link">
            See how they count in your checklist →
          </Link>
        </p>
      </div>

      {addPanel}

      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-xs" style={{ minWidth: `${rows.length * 3 * 9}rem` }}>
          <thead>
            <tr className="text-[11px] font-bold text-ink-700">
              {rows.map((y) => (
                <th key={y} colSpan={3} className="border-l-2 border-ink-300 bg-ink-50 px-2 py-1 text-left">
                  {y}–{String(y + 1).slice(2)}
                </th>
              ))}
            </tr>
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              {rows.flatMap((y) =>
                SEASONS.map((s) => (
                  <th key={`${y}${s.key}`} className={cn("border-t border-ink-200 px-1.5 py-1", s.key === "FA" ? "border-l-2 border-l-ink-300" : "border-l border-l-ink-200")}>
                    {s.label}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            <tr className="align-top">
              {rows.flatMap((y) => SEASONS.map((s) => {
                  const id = cellTerm(y, s.key);
                  const here = placed.filter((c) => c.termId === id);
                  const past = termKey(id) < cur;
                  const credits = here.reduce((a, c) => a + c.credits, 0);
                  return (
                    <td
                      key={id}
                      className={cn(
                        "border-t border-ink-200 px-1.5 py-1.5",
                        s.key === "FA" ? "border-l-2 border-l-ink-300" : "border-l border-l-ink-200",
                        past ? "bg-emerald-50/50" : id === currentTerm ? "bg-brand-50/60" : "",
                      )}
                    >
                      {abroadTerms.includes(id) && (
                        <div className="mb-1 inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
                          🌍 Study abroad
                        </div>
                      )}
                      {here.length === 0 ? (
                        <AddHere id={id} next={next} past={past} synced={synced.has(id)} />
                      ) : (
                        <ul className="space-y-1">
                          {here.map((c) => (
                            <li key={c.id} className={cn("leading-snug", isPlan(c) && "rounded border border-dashed border-ink-300 px-1")} title={`${c.code} — ${c.title}`}>
                              {past && !isPlan(c) && <span className="mr-0.5 text-emerald-700">✓</span>}
                              {c.glyph && <span aria-hidden>{c.glyph} </span>}{isPlan(c) && <span className="mr-1 text-[10px] font-semibold uppercase text-ink-500">plan</span>}
                              <span className="font-semibold text-ink-800">{c.manual ? c.title : c.code}</span>
                              {!c.manual && <span className="block truncate text-ink-500">{c.title}</span>}
                              <span className="text-ink-400"> {cr(c.credits)} cr</span>
                              {!past && (
                              <a
                                href={`${next}${next.includes("?") ? "&" : "?"}count=${encodeURIComponent(c.id)}#whatif`}
                                className={cn("ml-1 hover:opacity-100", activeId === c.id ? "opacity-100" : "opacity-40")}
                                title="Choose what this class counts for (updates What if)"
                                aria-label={`Choose what ${c.title} counts for`}
                              >
                                🎯
                              </a>
                              )}
                              {c.manual && (
                                <form action={removeManualCourseAction} className="ml-1 inline">
                                  <input type="hidden" name="id" value={c.id} />
                                  <input type="hidden" name="next" value={next} />
                                  <button
                                    type="submit"
                                    className="text-ink-300 hover:text-red-600"
                                    title="Remove this class"
                                    aria-label={`Remove ${c.title}`}
                                  >
                                    ✕
                                  </button>
                                </form>
                              )}
                            </li>
                          ))}
                          <li className="pt-0.5 text-[10px] font-semibold text-ink-500">
                            {cr(credits)} cr
                            {synced.has(id) && (
                              <>
                                {" · "}
                                <Link href={`/planner?term=${id}`} className="link font-normal">
                                  open
                                </Link>
                              </>
                            )}
                          </li>
                          <li>
                            <AddHere id={id} next={next} past={past} synced={synced.has(id)} />
                          </li>
                        </ul>
                      )}
                    </td>
                  );
              }))}
            </tr>
          </tbody>
        </table>
      </div>

      {loose.length > 0 && (
        <div className="border-t border-ink-100 pt-2 text-xs">
          <h3 className="font-semibold text-ink-600">Other (no term on the grid)</h3>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
            {loose.map((c) => (
              <li key={c.id} className="text-ink-700">
                {c.glyph} {c.title} <span className="text-ink-400">· {c.termLabel} · {cr(c.credits)} cr</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
