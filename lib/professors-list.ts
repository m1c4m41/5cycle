/** Shared by the professors page and its "load more" action. */
import { all, get } from "./db";
import { SCHOOLS } from "./constants";
import { schoolShort, termLabel } from "./util";
import { currentTermId } from "./ingest";
import { academicYearOf } from "./academic-year";

export type Row = {
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

export type SP = Record<string, string | string[] | undefined>;

export function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}

/** Whitelisted ORDER BY clauses — user input never reaches the SQL string. */
export const SORTS: Record<string, { label: string; short: string; order: string }> = {
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
    label: "Most sections this year",
    short: "Sections",
    order: "COALESCE(ay.n, 0) DESC, ir.name ASC",
  },
};

/** Quote LIKE wildcards so a literal "%" searches for "%". */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function buildFilters(sp: SP) {
  const q = one(sp.q);
  const sort = SORTS[one(sp.sort)] ? one(sp.sort) : "name";
  const rawSchool = one(sp.school).toUpperCase();
  const school = SCHOOLS.some((s) => s.code === rawSchool) ? rawSchool : "";

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
  return { q, sort, school, where, params };
}

/** One slice of the directory, plus the matching total and the academic-year labels. */
export async function fetchProfessors(sp: SP, offset: number, limit: number) {
  const { sort, where, params } = buildFilters(sp);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `FROM instructor_ratings ir JOIN instructors i ON i.id = ir.id`;

  // Teaching load = sections in the CURRENT academic year only (Fall → Spring).
  const ay = academicYearOf(await currentTermId());
  const ayTerms = ay?.termIds ?? [];
  const ayLabel = ay?.label ?? "this year";
  const ayTitle = ay
    ? `Sections taught in ${ay.termIds.map(termLabel).join(", ")} (only terms already published are counted)`
    : "Sections taught this academic year";
  const ayJoin = `LEFT JOIN (
      SELECT si.instructor_id AS iid, COUNT(*) AS n
      FROM section_instructors si JOIN sections s ON s.id = si.section_id
      WHERE s.term_id IN (${ayTerms.map(() => "?").join(",") || "NULL"})
      GROUP BY si.instructor_id
    ) ay ON ay.iid = ir.id`;

  const total = Number(
    (await get<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${clause}`, params))?.n ?? 0,
  );
  const rows = await all<Row>(
    `SELECT ir.id, ir.name, COALESCE(ay.n, 0) AS section_count, ir.review_count, ir.avg_stars,
            ir.rmp_quality, ir.rmp_difficulty, ir.rmp_num_ratings, ir.rmp_url,
            i.home_school
     ${from} ${ayJoin} ${clause}
     ORDER BY ${SORTS[sort].order}
     LIMIT ? OFFSET ?`,
    [...ayTerms, ...params, limit, offset],
  );
  return { rows, total, ayLabel, ayTitle };
}

export { schoolShort };
