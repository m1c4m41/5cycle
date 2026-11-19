/**
 * Four-year course schedule (like the advising spreadsheet): one row per
 * academic year, Fall / Spring / Summer columns, every class the student has
 * saved or entered — past terms marked as taken.
 */
import Link from "next/link";
import { addManualCourseAction, removeManualCourseAction } from "@/actions/requirements";
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

/** "+ add class" inside a term cell: type a class you took (or plan) in that term. */
function AddHere({ id, synced, next, future, cls }: { id: string; synced: boolean; next: string; future: boolean; cls?: string }) {
  return (
    <details className={cn("group", cls)}>
      <summary className="cursor-pointer list-none text-ink-400 hover:text-brand-700 [&::-webkit-details-marker]:hidden">
        + add class
      </summary>
      <form action={addManualCourseAction} className="mt-1 space-y-1 rounded-md border border-ink-200 bg-white p-1.5 shadow-sm">
        <input
          type="text"
          name="title"
          required
          placeholder="Course, e.g. Biochemistry"
          className="input w-full !px-1.5 !py-1 text-xs"
          aria-label={`Course title for ${termLabel(id)}`}
        />
        <div className="flex gap-1">
          <input
            type="number"
            name="credits"
            required
            min="0.25"
            max="12"
            step="0.25"
            defaultValue="1"
            className="input w-16 !px-1.5 !py-1 text-xs"
            aria-label="Credits (5C)"
            title="5C credits (a normal course is 1)"
          />
          <select name="kind" defaultValue={future ? "planned" : "custom"} className="input min-w-0 flex-1 !px-1 !py-1 text-xs" aria-label="Type">
            <option value="planned">📌 Want to take (no section yet)</option>
            <option value="custom">Course taken</option>
            <option value="transfer">Transfer / AP</option>
            <option value="abroad">Study abroad</option>
          </select>
        </div>
        {synced ? (
          <input type="hidden" name="termId" value={id} />
        ) : (
          <input type="hidden" name="termLabel" value={termLabel(id)} />
        )}
        <input type="hidden" name="next" value={next} />
        <button type="submit" className="btn-primary w-full !px-2 !py-1 text-xs">
          Add to {termLabel(id)}
        </button>
      </form>
    </details>
  );
}

export function CourseHistory({
  courses,
  currentTerm,
  syncedTerms,
  next,
}: {
  courses: HistoryCourse[];
  currentTerm: string;
  syncedTerms: string[];
  /** Where the add / remove forms return to. */
  next: string;
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
          <span className="text-emerald-700">✓ = past term</span>
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-xs">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              <th className="w-16 px-1 pb-1">Year</th>
              {SEASONS.map((s) => (
                <th key={s.key} className="px-1 pb-1">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((y) => (
              <tr key={y} className="align-top">
                <th className="border-t border-ink-200 px-1 py-1.5 text-left font-semibold text-ink-700">
                  {y}–{String(y + 1).slice(2)}
                </th>
                {SEASONS.map((s) => {
                  const id = cellTerm(y, s.key);
                  const here = placed.filter((c) => c.termId === id);
                  const past = termKey(id) < cur;
                  const credits = here.reduce((a, c) => a + c.credits, 0);
                  return (
                    <td
                      key={id}
                      className={cn(
                        "border-l border-t border-ink-200 px-1.5 py-1.5",
                        past ? "bg-emerald-50/50" : id === currentTerm ? "bg-brand-50/60" : "",
                      )}
                    >
                      {here.length === 0 ? (
                        <AddHere id={id} synced={synced.has(id)} next={next} future={termKey(id) >= cur} />
                      ) : (
                        <ul className="space-y-1">
                          {here.map((c) => (
                            <li key={c.id} className={cn("leading-snug", isPlan(c) && "rounded border border-dashed border-ink-300 px-1")} title={`${c.code} — ${c.title}`}>
                              {past && !isPlan(c) && <span className="mr-0.5 text-emerald-700">✓</span>}
                              {c.glyph && <span aria-hidden>{c.glyph} </span>}{isPlan(c) && <span className="mr-1 text-[10px] font-semibold uppercase text-ink-500">plan</span>}
                              <span className="font-semibold text-ink-800">{c.manual ? c.title : c.code}</span>
                              {!c.manual && <span className="block truncate text-ink-500">{c.title}</span>}
                              <span className="text-ink-400"> {cr(c.credits)} cr</span>
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
                            <AddHere id={id} synced={synced.has(id)} next={next} future={termKey(id) >= cur} />
                          </li>
                        </ul>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
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
