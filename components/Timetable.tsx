/**
 * Weekly timetable, rendered on the server.
 *
 * Absolute positioning inside one column per weekday keeps overlapping
 * sections readable: lib/schedule.ts already splits clashes into side-by-side
 * lanes, so a double-booked pair shows as two half-width blocks rather than
 * hiding one behind the other. That is deliberate — a planner that silently
 * hides conflicts is a planner that helps you build an impossible schedule.
 */
import Link from "next/link";
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from "@/lib/constants";
import { toGridBlocks, type GridBlock, type GridSection } from "@/lib/grid-blocks";
import { SCHOOL_BY_CODE } from "@/lib/constants";
import { secondsTo12h } from "@/lib/util";

type Axis = { start: number; end: number; px: number; height: number };

/** Axis fitted to the classes actually on the grid: from the hour before the
 *  earliest class to the hour after the latest one (no empty 8am–10pm frame),
 *  scaled so the whole thing fits a fixed height — no scrolling. */
function fitAxis(starts: number[], ends: number[], targetHeight: number): Axis {
  if (!starts.length) {
    const start = 9 * 3600;
    const end = 17 * 3600;
    return { start, end, px: targetHeight / ((end - start) / 60), height: targetHeight };
  }
  let start = Math.floor(Math.min(...starts) / 3600) * 3600;
  let end = Math.ceil(Math.max(...ends) / 3600) * 3600;
  if (end - start < 4 * 3600) end = start + 4 * 3600;
  const mins = (end - start) / 60;
  const px = Math.min(1.1, Math.max(0.45, targetHeight / mins));
  return { start, end, px, height: Math.round(mins * px) };
}

const offsetIn = (a: Axis, sec: number) =>
  ((Math.max(a.start, Math.min(a.end, sec)) - a.start) / 60) * a.px;

function accent(code: string) {
  return SCHOOL_BY_CODE[code]?.accent ?? "var(--color-brand-600)";
}

function Block({ b, axis, ghost, conflict }: { b: GridBlock; axis: Axis; ghost?: boolean; conflict?: boolean }) {
  const top = offsetIn(axis, b.start);
  const bottom = offsetIn(axis, b.end);
  const height = Math.max(bottom - top, 20);
  const width = `calc(${100 / b.lanes}% - 3px)`;
  const left = `calc(${(b.lane * 100) / b.lanes}% + 1px)`;
  const color = accent(b.section.school);
  return (
    <Link
      href={`/section/${encodeURIComponent(b.section.id)}`}
      className={
        ghost
          ? "absolute z-10 overflow-hidden rounded-md border-2 border-dashed px-1 py-0.5 text-[10px] leading-tight hover:z-20"
          : "absolute overflow-hidden rounded-md border px-1 py-0.5 text-[10px] leading-tight shadow-sm hover:z-20 hover:shadow"
      }
      style={{
        top: `${top}px`,
        height: `${height}px`,
        left,
        width,
        borderColor: conflict ? "#d97706" : color,
        background: ghost
          ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 22%, transparent) 0 6px, color-mix(in srgb, ${color} 10%, transparent) 6px 12px)`
          : `color-mix(in srgb, ${color} 14%, white)`,
        color: "var(--color-ink-900)",
        ...(ghost ? { opacity: 0.92 } : {}),
      }}
      title={`${b.section.code_string} — ${b.section.title} (${secondsTo12h(b.start)}–${secondsTo12h(b.end)})`}
    >
      <div className="truncate font-semibold" style={{ color }}>
        {ghost && <span aria-hidden>👁 </span>}
        {conflict && !ghost && <span aria-hidden title="Overlaps another class">⚠ </span>}
        {b.section.department} {String(b.section.course_number).padStart(3, "0")}
        {b.section.suffix}
      </div>
      {height > 30 && (
        <div className="truncate text-ink-600">
          {secondsTo12h(b.start).replace(":00", "")}–{secondsTo12h(b.end).replace(":00", "")}
        </div>
      )}
      {height > 70 && (
        <div className="truncate text-ink-500">{b.section.title}</div>
      )}
      {height > 90 && b.section.meetings.find((m) => m.days === b.day)?.locations && (
        <div className="truncate text-ink-400">
          {b.section.meetings.find((m) => m.days === b.day)!.locations}
        </div>
      )}
    </Link>
  );
}

export function Timetable({
  sections,
  targetHeight = 380,
  ghostIds,
  conflictIds,
}: {
  sections: GridSection[];
  targetHeight?: number;
  /** Preview-only classes (not in the plan): drawn as shaded boxes. */
  ghostIds?: Set<string>;
  /** Classes that overlap another one: tagged ⚠. */
  conflictIds?: Set<string>;
}) {
  const blocks = toGridBlocks(sections);
  const days = WEEKDAY_ORDER.filter(
    (d) => (d === "S" || d === "U") ? (blocks[d]?.length ?? 0) > 0 : true,
  );

  const all = Object.values(blocks).flat();
  const axis = fitAxis(
    all.map((b) => b.start),
    all.map((b) => b.end),
    targetHeight,
  );
  // Gutter marks only where a class starts (rounded to the minute), thinned so
  // labels never collide.
  const marks: number[] = [];
  for (const t of [...new Set(all.map((b) => b.start))].sort((a, b) => a - b)) {
    const last = marks[marks.length - 1];
    if (last === undefined || ((t - last) / 60) * axis.px >= 14) marks.push(t);
  }

  const unscheduled = sections.filter((s) => s.meetings.length === 0);

  return (
    <div className="space-y-3">
      <div>
        <div>
          <div
            className="grid border-b border-ink-200 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500"
            style={{ gridTemplateColumns: `2.75rem repeat(${days.length}, minmax(0, 1fr))` }}
          >
            <div />
            {days.map((d) => (
              <div key={d} className="px-1 text-center">
                {WEEKDAY_LABELS[d]}
              </div>
            ))}
          </div>

          <div
            className="grid"
            style={{ gridTemplateColumns: `2.75rem repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {/* Hour gutter */}
            <div className="relative" style={{ height: `${axis.height}px` }}>
              {marks.map((h) => (
                <div
                  key={h}
                  className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-ink-500"
                  style={{ top: `${offsetIn(axis, h)}px` }}
                >
                  {secondsTo12h(h).replace(":00", "")}
                </div>
              ))}
            </div>

            {days.map((d) => (
              <div
                key={d}
                className="relative border-l border-ink-200 bg-white"
                style={{ height: `${axis.height}px` }}
              >
                {marks.map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-ink-100"
                    style={{ top: `${offsetIn(axis, h)}px` }}
                  />
                ))}
                {(blocks[d] ?? []).map((b, i) => (
                  <Block key={`${b.section.id}-${i}`} b={b} axis={axis} ghost={ghostIds?.has(b.section.id)} conflict={conflictIds?.has(b.section.id)} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {unscheduled.length > 0 && (
        <p className="text-xs text-ink-500">
          {unscheduled.length} course{unscheduled.length === 1 ? "" : "s"} have no scheduled
          meeting time in the feed (asynchronous, TBA, a term-limited block, or a manually added
          course) and are not on the grid:{" "}
          {unscheduled.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              {s.manual ? (
                <span className="font-mono" title={`${s.title} — manually added (${s.manual.termLabel})`}>
                  {s.code_string}
                </span>
              ) : (
                <Link href={`/section/${encodeURIComponent(s.id)}`} className="font-mono link">
                  {s.code_string}
                </Link>
              )}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
