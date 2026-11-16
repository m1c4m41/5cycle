/**
 * Read-side helpers for pages (kept out of "use server" action files, which may
 * only export async functions).
 */
import { all, get } from "./db";
import { catalogStats } from "./ingest";
import { normalizeName } from "./util";
import type { InstructorSummary, ReviewRow } from "./types";

export async function adminSnapshot() {
  return {
    stats: await catalogStats(),
    requirementSets: Number((await get<{ n: number }>("SELECT COUNT(*) n FROM requirement_sets"))?.n ?? 0),
    unverifiedSets: Number(
      (await get<{ n: number }>("SELECT COUNT(*) n FROM requirement_sets WHERE verified = 0"))?.n ?? 0,
    ),
    rmpCached: Number(
      (await get<{ n: number }>("SELECT COUNT(*) n FROM instructors WHERE rmp_url IS NOT NULL"))?.n ?? 0,
    ),
    lastSync: (await get<{ v: string }>("SELECT value v FROM meta WHERE key = 'terms_synced_at'"))?.v ?? null,
  };
}

/* ------------------------------- professors ------------------------------ */

export async function instructorSummary(id: string): Promise<InstructorSummary | undefined> {
  return get<InstructorSummary>(
    `SELECT i.id, i.name, i.home_school, i.section_count,
            COUNT(r.id)                    AS review_count,
            ROUND(AVG(r.stars), 2)         AS avg_stars,
            ROUND(AVG(r.difficulty), 2)    AS avg_difficulty,
            i.rmp_quality, i.rmp_difficulty, i.rmp_num_ratings, i.rmp_url, i.rmp_tags
     FROM instructors i LEFT JOIN reviews r ON r.instructor_id = i.id
     WHERE i.id = ? GROUP BY i.id`,
    [id],
  );
}

export async function instructorReviews(id: string): Promise<ReviewRow[]> {
  // node:sqlite returns null-prototype rows; spread into plain objects so
  // they can be serialized into client components (ReviewForm `existing`).
  const rows = await all<ReviewRow>(
    `SELECT r.id, r.instructor_id, r.section_id, r.stars, r.difficulty, r.workload,
            r.grade, r.take_again, r.text, r.tags, r.created_at,
            'A 5C student' AS author, s.course_code
     FROM reviews r
     LEFT JOIN sections s ON s.id = r.section_id
     WHERE r.instructor_id = ?
     ORDER BY r.created_at DESC`,
    [id],
  );
  return rows.map((r) => ({ ...r }));
}

/** Tag chips, most-mentioned first. */
export async function reviewTagsFor(instructorId: string): Promise<string[]> {
  const rows = await all<{ tags: string }>(
    "SELECT tags FROM reviews WHERE instructor_id = ? AND tags <> ''",
    [instructorId],
  );
  const counts = new Map<string, number>();
  for (const r of rows)
    for (const t of r.tags.split(",")) {
      const tag = t.trim();
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);
}

export async function sectionsTaughtBy(instructorId: string, limit = 40) {
  return all<{
    id: string;
    code_string: string;
    title: string;
    term_id: string;
    school: string;
  }>(
    `SELECT s.id, s.code_string, s.title, s.term_id, s.school
     FROM sections s JOIN section_instructors si ON si.section_id = s.id
     WHERE si.instructor_id = ?
     ORDER BY s.term_id DESC, s.code_string ASC LIMIT ?`,
    [instructorId, limit],
  );
}

export async function findInstructorByName(name: string): Promise<string | null> {
  return (
    (await get<{ id: string }>("SELECT id FROM instructors WHERE normalized = ?", [normalizeName(name)]))
      ?.id ?? null
  );
}
