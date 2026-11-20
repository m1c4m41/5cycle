/**
 * Sample-plan builder used by the profile "fill my plan" tool.
 *
 * The plan is *derived* — it asks the requirement engine which slots are still
 * open and then picks real, open, non-conflicting sections from the live
 * catalog that close them. That means the sample never shows a course that
 * isn't actually being offered, and it always demonstrates the checklist moving.
 */
import { newId, nowIso, run, tx } from "./db";
import { sectionsForTerm } from "./catalog";
import { groupMatches, listSets } from "./requirements";
import { findConflicts } from "./schedule";
import type { Section, UserRow } from "./types";

export type PlanChoice = {
  section: Section;
  reason: string;
};

/**
 * Pick up to `maxCourses` open sections in `termId` that each advance an
 * outstanding requirement, without clashing with one another.
 */
export async function buildSamplePlan(
  user: Pick<UserRow, "school" | "major_id" | "major2_id" | "minor_id"> & { track_id?: string | null },
  termId: string,
  maxCourses = 5,
): Promise<PlanChoice[]> {
  const sets = (await listSets()).filter(
    (s) =>
      s.id === `ge-${user.school}` ||
      s.id === user.major_id ||
      s.id === user.major2_id ||
      s.id === user.minor_id ||
      s.id === user.track_id,
  );
  const pool = (await sectionsForTerm(termId, true)).filter(
    (s) => s.credits_5c > 0 && s.meetings.length > 0 && !s.potential_error,
  );

  const chosen: PlanChoice[] = [];
  const taken = new Set<string>();

  const conflictsWithChosen = (s: Section) =>
    findConflicts([...chosen.map((c) => c.section), s]).some(
      (c) => c.a.id === s.id || c.b.id === s.id,
    );

  // Required groups first, then electives, then anything else.
  const buckets = sets.flatMap((set) =>
    set.groups.map((g) => ({ set, g })),
  );
  const ordered = [
    ...buckets.filter((b) => b.g.required !== 0),
    ...buckets.filter((b) => b.g.required === 0),
  ];

  for (const { set, g } of ordered) {
    if (chosen.length >= maxCourses) break;
    const need = Math.max(1, g.min_courses ?? 1);
    let got = 0;
    for (const s of pool) {
      if (chosen.length >= maxCourses || got >= need) break;
      if (taken.has(s.id)) continue;
      if (!groupMatches(g, s)) continue;
      if (conflictsWithChosen(s)) continue;
      chosen.push({
        section: s,
        reason:
          set.kind === "ge"
            ? `GE — ${g.name}`
            : set.kind === "major"
              ? `Major — ${g.name}`
              : `Minor — ${g.name}`,
      });
      taken.add(s.id);
      got++;
    }
  }

  // Top up to a full course load with popular open courses that don't clash.
  if (chosen.length < maxCourses) {
    for (const s of pool) {
      if (chosen.length >= maxCourses) break;
      if (taken.has(s.id)) continue;
      if (conflictsWithChosen(s)) continue;
      if (s.perm_count === 0 && s.school !== user.school) continue;
      chosen.push({ section: s, reason: "Free elective" });
      taken.add(s.id);
    }
  }

  return chosen;
}

export async function applySamplePlan(userId: string, choices: PlanChoice[]): Promise<number> {
  if (!choices.length) return 0;
  return tx(async () => {
    let n = 0;
    for (const c of choices) {
      await run(
        `INSERT OR IGNORE INTO enrollments(id, user_id, section_id, term_id, status, note, added_at)
         VALUES(?,?,?,?,?,?,?)`,
        [newId("enr-"), userId, c.section.id, c.section.term_id, "planned", "sample", nowIso()],
      );
      n += 1;
    }
    return n;
  });
}
