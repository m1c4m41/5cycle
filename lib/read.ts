/**
 * Read-side helpers for pages (kept out of "use server" action files, which may
 * only export async functions).
 */
import { all, get } from "./db";
import { catalogStats } from "./ingest";
import { normalizeName } from "./util";
import type { InstructorSummary, ReviewRow } from "./types";

// Parallel fan-out: catalogStats() (3 statements) + two combined reads.
// Used to be 12 serial round-trips (~420ms); now ~40ms end to end.
export async function adminSnapshot() {
  const [stats, sets, extra] = await Promise.all([
    catalogStats(),
    get<{ total: number; unverified: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(verified = 0), 0) AS unverified FROM requirement_sets",
    ),
    get<{ rmp: number; sync: string | null }>(
      `SELECT (SELECT COUNT(*) FROM instructors WHERE rmp_url IS NOT NULL) AS rmp,
              (SELECT value FROM meta WHERE key = 'terms_synced_at') AS sync`,
    ),
  ]);
  return {
    stats,
    requirementSets: Number(sets?.total ?? 0),
    unverifiedSets: Number(sets?.unverified ?? 0),
    rmpCached: Number(extra?.rmp ?? 0),
    lastSync: extra?.sync ?? null,
  };
}

/* ------------------------------- professors ------------------------------ */

export async function instructorSummary(id: string): Promise<InstructorSummary | undefined> {
  return get<InstructorSummary>(
    `SELECT i.id, i.name, i.home_school, i.section_count,
            COUNT(r.id)                    AS review_count,
            ROUND(AVG(r.stars), 2)         AS avg_stars,
            ROUND(AVG(r.difficulty), 2)    AS avg_difficulty,
            i.rmp_quality, i.rmp_difficulty, i.rmp_num_ratings, i.rmp_url, i.rmp_tags, i.rmp_synced_at
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

export type ReviewWithProfessor = ReviewRow & { professor_id: string; professor_name: string; mine: boolean };

/**
 * Every review ever written, newest first, across all professors. Reviews are
 * only ever removed when their author deletes their account (or deletes the
 * review), never by a catalog sync.
 */
export async function allReviews(opts: {
  userId?: string | null;
  mineOnly?: boolean;
  limit: number;
  offset: number;
}): Promise<{ rows: ReviewWithProfessor[]; total: number; professors: number }> {
  const where = opts.mineOnly && opts.userId ? "WHERE r.user_id = ?" : "";
  const params = opts.mineOnly && opts.userId ? [opts.userId] : [];
  const [rows, totals] = await Promise.all([
    all<ReviewWithProfessor>(
      `SELECT r.id, r.instructor_id, r.section_id, r.stars, r.difficulty, r.workload,
              r.grade, r.take_again, r.text, r.tags, r.created_at,
              'A 5C student' AS author, s.course_code,
              i.id AS professor_id, i.name AS professor_name,
              CASE WHEN r.user_id = ? THEN 1 ELSE 0 END AS mine
       FROM reviews r
       JOIN instructors i ON i.id = r.instructor_id
       LEFT JOIN sections s ON s.id = r.section_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [opts.userId ?? "", ...params, opts.limit, opts.offset],
    ),
    get<{ n: number; p: number }>(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT r.instructor_id) AS p FROM reviews r ${where}`,
      params,
    ),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, mine: Boolean(Number(r.mine)) })),
    total: Number(totals?.n ?? 0),
    professors: Number(totals?.p ?? 0),
  };
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
