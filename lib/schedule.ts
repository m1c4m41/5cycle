/**
 * The planner: what a student has placed in each term, whether it clashes,
 * and how much of the load each campus is carrying.
 */
import { all, get, newId, nowIso, run } from "./db";
import { getSectionsByIds, getSection } from "./catalog";
import type { Section } from "./types";
import { overlaps } from "./util";

export type EnrollmentRow = {
  id: string;
  section_id: string;
  term_id: string;
  status: string;
  note: string | null;
  planned_year: number | null;
  added_at: string;
};

export type Enrollment = EnrollmentRow & { section: Section };

export function listEnrollments(userId: string, termId?: string): Enrollment[] {
  const rows = termId
    ? all<EnrollmentRow>(
        "SELECT * FROM enrollments WHERE user_id = ? AND term_id = ? ORDER BY added_at ASC",
        [userId, termId],
      )
    : all<EnrollmentRow>(
        "SELECT * FROM enrollments WHERE user_id = ? ORDER BY term_id DESC, added_at ASC",
        [userId],
      );
  const sections = getSectionsByIds(rows.map((r) => r.section_id));
  const byId = new Map(sections.map((s) => [s.id, s]));
  return rows
    .map((r) => ({ ...r, section: byId.get(r.section_id) }))
    .filter((x): x is Enrollment => Boolean(x.section));
}

export function enrolledSections(userId: string, termId?: string): Section[] {
  return listEnrollments(userId, termId).map((e) => e.section);
}

export type Conflict = {
  a: Section;
  b: Section;
  days: string;
  start: number;
  end: number;
};

/** Every pair of sections in `list` that meet at the same time on a shared day. */
export function findConflicts(list: Section[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (const ma of list[i].meetings) {
        for (const mb of list[j].meetings) {
          const shared = [...ma.days].filter((d) => mb.days.includes(d)).join("");
          if (!shared) continue;
          if (overlaps(ma.start_time, ma.end_time, mb.start_time, mb.end_time)) {
            out.push({
              a: list[i],
              b: list[j],
              days: shared,
              start: Math.max(ma.start_time, mb.start_time),
              end: Math.min(ma.end_time, mb.end_time),
            });
          }
        }
      }
    }
  }
  return out;
}

export type AddResult =
  | { ok: true; enrollment: Enrollment; conflicts: Conflict[]; warning?: string }
  | { ok: false; error: string; conflicts?: Conflict[] };

export function addToSchedule(
  userId: string,
  sectionId: string,
  opts: { status?: string; note?: string; force?: boolean } = {},
): AddResult {
  const section = getSection(sectionId);
  if (!section) return { ok: false, error: "That section is not in the synced catalog." };

  const existing = get<EnrollmentRow>(
    "SELECT * FROM enrollments WHERE user_id = ? AND section_id = ?",
    [userId, sectionId],
  );
  if (existing) {
    return { ok: true, enrollment: { ...existing, section }, conflicts: [], warning: "Already in your schedule." };
  }

  const current = enrolledSections(userId, section.term_id);
  const conflicts = findConflicts([...current, section]).filter(
    (c) => c.a.id === sectionId || c.b.id === sectionId,
  );
  if (conflicts.length && !opts.force) {
    return {
      ok: false,
      error: "Time conflict with a class already in this term.",
      conflicts,
    };
  }

  const id = newId("enr-");
  run(
    `INSERT INTO enrollments(id, user_id, section_id, term_id, status, note, added_at)
     VALUES(?,?,?,?,?,?,?)`,
    [id, userId, sectionId, section.term_id, opts.status ?? "planned", opts.note ?? null, nowIso()],
  );
  const row = get<EnrollmentRow>("SELECT * FROM enrollments WHERE id = ?", [id])!;
  return { ok: true, enrollment: { ...row, section }, conflicts };
}

export function removeFromSchedule(userId: string, sectionId: string): boolean {
  const res = run("DELETE FROM enrollments WHERE user_id = ? AND section_id = ?", [
    userId,
    sectionId,
  ]);
  return Number(res.changes) > 0;
}

export function setEnrollmentStatus(
  userId: string,
  sectionId: string,
  status: string,
  note?: string,
) {
  run(
    note === undefined
      ? "UPDATE enrollments SET status = ? WHERE user_id = ? AND section_id = ?"
      : "UPDATE enrollments SET status = ?, note = ? WHERE user_id = ? AND section_id = ?",
    note === undefined ? [status, userId, sectionId] : [status, note, userId, sectionId],
  );
}

export type TermSummary = {
  termId: string;
  count: number;
  credits5c: number;
  creditsBySchool: Record<string, number>;
  conflicts: Conflict[];
  crossCampus: number;
  needsPerm: number;
};

export function summarizeTerm(
  userId: string,
  termId: string,
  homeSchool: string,
): TermSummary {
  const sections = enrolledSections(userId, termId);
  const creditsBySchool: Record<string, number> = {};
  let cross = 0;
  for (const s of sections) {
    creditsBySchool[s.school] = Number(
      ((creditsBySchool[s.school] ?? 0) + s.credits_5c).toFixed(2),
    );
    if (s.school !== homeSchool) cross++;
  }
  return {
    termId,
    count: sections.length,
    credits5c: Number(sections.reduce((a, b) => a + b.credits_5c, 0).toFixed(2)),
    creditsBySchool,
    conflicts: findConflicts(sections),
    crossCampus: cross,
    needsPerm: cross,
  };
}

/** Distinct terms the student has planned anything in (newest first). */
export function plannedTerms(userId: string): string[] {
  return all<{ term_id: string }>(
    "SELECT DISTINCT term_id FROM enrollments WHERE user_id = ? ORDER BY term_id DESC",
    [userId],
  ).map((r) => r.term_id);
}

/* ---------------------------- weekly grid cells --------------------------- */

export type GridBlock = {
  section: Section;
  day: string;
  start: number;
  end: number;
  lane: number;
  lanes: number;
};

/** Lay out sections into weekday columns, splitting overlaps into side-by-side lanes. */
export function toGridBlocks(sections: Section[]): Record<string, GridBlock[]> {
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
