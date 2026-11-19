/**
 * Weekly-grid layout, pure (no database), so the browser can lay out the live
 * catalog grid — preview ghosts, hidden classes — without a server round trip.
 */
import type { Meeting, Section } from "./types";
import { overlaps } from "./util";

/** The slice of a section the grid needs (small enough to hand to client components). */
export type GridSection = Pick<
  Section,
  "id" | "term_id" | "school" | "department" | "course_number" | "suffix" | "title" | "code_string" | "credits_5c"
> & { meetings: Meeting[]; manual?: Section["manual"] };

export function toGridSection(s: GridSection): GridSection {
  return {
    id: s.id,
    term_id: s.term_id,
    school: s.school,
    department: s.department,
    course_number: s.course_number,
    suffix: s.suffix,
    title: s.title,
    code_string: s.code_string,
    credits_5c: s.credits_5c,
    meetings: s.meetings.map((m) => ({ days: m.days, start_time: m.start_time, end_time: m.end_time, locations: m.locations })),
    ...(s.manual ? { manual: s.manual } : {}),
  };
}

/** Ids of classes in `list` that overlap another class in `list`. */
export function overlappingIds(list: GridSection[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      for (const a of list[i].meetings)
        for (const b of list[j].meetings)
          if ([...a.days].some((d) => b.days.includes(d)) && overlaps(a.start_time, a.end_time, b.start_time, b.end_time)) {
            out.add(list[i].id);
            out.add(list[j].id);
          }
  return out;
}

export type GridBlock = {
  section: GridSection;
  day: string;
  start: number;
  end: number;
  lane: number;
  lanes: number;
};

/** Lay out sections into weekday columns, splitting overlaps into side-by-side lanes. */
export function toGridBlocks(sections: GridSection[]): Record<string, GridBlock[]> {
  const byDay: Record<string, GridBlock[]> = {
    M: [],
    T: [],
    W: [],
    R: [],
    F: [],
    S: [],
    U: [],
  };
  for (const s of sections) {
    for (const m of s.meetings) {
      for (const d of m.days.split("")) {
        if (byDay[d]) {
          byDay[d].push({
            section: s,
            day: d,
            start: m.start_time,
            end: m.end_time,
            lane: 0,
            lanes: 1,
          });
        }
      }
    }
  }
  for (const day of Object.keys(byDay)) {
    const blocks = byDay[day].sort((a, b) => a.start - b.start || a.end - b.end);
    // Greedy lane assignment, like a calendar app.
    const laneEnds: number[] = [];
    for (const b of blocks) {
      let lane = laneEnds.findIndex((end) => end <= b.start);
      if (lane === -1) {
        laneEnds.push(b.end);
        lane = laneEnds.length - 1;
      } else {
        laneEnds[lane] = b.end;
      }
      b.lane = lane;
    }
    const lanes = laneEnds.length || 1;
    for (const b of blocks) b.lanes = lanes;
  }
  return byDay;
}
