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
import {
  TIMETABLE_END,
  TIMETABLE_START,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
} from "@/lib/constants";
import { toGridBlocks, type GridBlock } from "@/lib/schedule";
import type { Section } from "@/lib/types";
import { SCHOOL_BY_CODE } from "@/lib/constants";
import { secondsTo12h } from "@/lib/util";

/** Pixels per minute of class time. */
const PX_PER_MIN = 1.15;
const TOTAL_MIN = (TIMETABLE_END - TIMETABLE_START) / 60;
const GRID_HEIGHT = Math.round(TOTAL_MIN * PX_PER_MIN);

const clamp = (v: number) => Math.max(TIMETABLE_START, Math.min(TIMETABLE_END, v));

function offset(sec: number) {
  return ((clamp(sec) - TIMETABLE_START) / 60) * PX_PER_MIN;
}

function accent(code: string) {
  return SCHOOL_BY_CODE[code]?.accent ?? "var(--color-brand-600)";
}

function Block({ b }: { b: GridBlock }) {
  const top = offset(b.start);
  const bottom = offset(b.end);
  const height = Math.max(bottom - top, 22);
  const width = `calc(${100 / b.lanes}% - 3px)`;
  const left = `calc(${(b.lane * 100) / b.lanes}% + 1px)`;
  const color = accent(b.section.school);
  return (
    <Link
      href={`/section/${encodeURIComponent(b.section.id)}`}
      className="absolute overflow-hidden rounded-md border px-1.5 py-1 text-[11px] leading-tight shadow-sm hover:z-20 hover:shadow"
      style={{
        top: `${top}px`,
        height: `${height}px`,
        left,
        width,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 14%, white)`,
        color: "var(--color-ink-900)",
      }}
      title={`${b.section.code_string} — ${b.section.title} (${secondsTo12h(b.start)}–${secondsTo12h(b.end)})`}
    >
      <div className="truncate font-semibold" style={{ color }}>
        {b.section.department} {String(b.section.course_number).padStart(3, "0")}
        {b.section.suffix}
      </div>
      <div className="truncate text-ink-600">
        {secondsTo12h(b.start)}–{secondsTo12h(b.end)}
      </div>
      {height > 52 && (
        <div className="truncate text-ink-500">{b.section.title}</div>
      )}
      {height > 70 && b.section.meetings.find((m) => m.days === b.day)?.locations && (
        <div className="truncate text-ink-400">
          {b.section.meetings.find((m) => m.days === b.day)!.locations}
        </div>
      )}
    </Link>
  );
}

export function Timetable({ sections }: { sections: Section[] }) {
  const blocks = toGridBlocks(sections);
  const days = WEEKDAY_ORDER.filter(
    (d) => (d === "S" || d === "U") ? (blocks[d]?.length ?? 0) > 0 : true,
  );

  const hours: number[] = [];
  for (let s = TIMETABLE_START; s <= TIMETABLE_END; s += 3600) hours.push(s);

  const unscheduled = sections.filter((s) => s.meetings.length === 0);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto scroll-thin">
        <div className="min-w-[620px]">
          <div
            className="grid border-b border-ink-200 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500"
            style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}
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
            style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {/* Hour gutter */}
            <div className="relative" style={{ height: `${GRID_HEIGHT}px` }}>
              {hours.map((h, i) => (
                <div
                  key={h}
                  className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-ink-400"
                  style={{ top: `${offset(h)}px` }}
                >
                  {i === 0 ? "" : secondsTo12h(h).replace(":00", "")}
                </div>
              ))}
            </div>

            {days.map((d) => (
              <div
                key={d}
                className="relative border-l border-ink-200 bg-white"
                style={{ height: `${GRID_HEIGHT}px` }}
              >
                {hours.map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-ink-100"
                    style={{ top: `${offset(h)}px` }}
                  />
                ))}
                {(blocks[d] ?? []).map((b, i) => (
                  <Block key={`${b.section.id}-${i}`} b={b} />
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
