/** Catalog search + hydration. All filtering happens in SQL so the UI can
 *  page through 2,000+ live sections without shipping them to the browser. */
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { all, get } from "./db";
import { termChronoKey } from "./hyperschedule";
import type { AreaRef, InstructorRef, Meeting, Section, SectionRow } from "./types";
import { schoolShort } from "./util";

export type CatalogQuery = {
  q?: string;
  term?: string;
  schools?: string[];
  departments?: string[];
  areas?: string[];
  instructor?: string;
  minCredits?: number;
  maxCredits?: number;
  openOnly?: boolean;
  permOnly?: boolean;
  /** Only courses taught somewhere *other* than this campus (cross-registration shopping). */
  notAtSchool?: string;
  limit?: number;
  offset?: number;
  sort?: "code" | "title" | "credits" | "perm";
};

const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;

type Built = { where: string[]; params: (string | number | null)[] };

function buildWhere(q: CatalogQuery): Built {
  const where: string[] = [];
  const params: (string | number | null)[] = [];

  if (q.term) {
    where.push("s.term_id = ?");
    params.push(q.term);
  }
  if (q.schools?.length) {
    where.push(`s.school IN (${q.schools.map(() => "?").join(",")})`);
    params.push(...q.schools);
  }
  if (q.notAtSchool) {
    where.push("s.school <> ?");
    params.push(q.notAtSchool);
  }
  if (q.departments?.length) {
    where.push(`s.department IN (${q.departments.map(() => "?").join(",")})`);
    params.push(...q.departments);
  }
  if (q.areas?.length) {
    // A section must carry *all* requested designations.
    for (const a of q.areas) {
      where.push(
        `EXISTS (SELECT 1 FROM section_areas sa WHERE sa.section_id = s.id AND sa.area_code = ?)`,
      );
      params.push(a);
    }
  }
  if (q.instructor) {
    where.push(
      `EXISTS (SELECT 1 FROM section_instructors si JOIN instructors i ON i.id = si.instructor_id
              WHERE si.section_id = s.id AND i.normalized LIKE ?)`,
    );
    params.push(`%${q.instructor.toLowerCase().trim()}%`);
  }
  if (typeof q.minCredits === "number" && !Number.isNaN(q.minCredits)) {
    where.push("s.credits >= ?");
    params.push(q.minCredits);
  }
  if (typeof q.maxCredits === "number" && !Number.isNaN(q.maxCredits)) {
    where.push("s.credits <= ?");
    params.push(q.maxCredits);
  }
  if (q.openOnly) {
    where.push("s.status IN ('O','R')");
  }
  if (q.permOnly) {
    where.push("s.perm_count > 0");
  }
  const qc = q.q ? buildQClause(q.q) : null;
  if (qc) {
    where.push(qc.clause);
    params.push(...qc.params);
  }
  return { where, params };
}

type QClause = { clause: string; params: (string | number | null)[] };

/**
 * The WHERE fragment for a free-text query. Fuzzy / buzzword search: every
 * token is OR-combined so "chem" pulls up lectures AND labs, and a
 * course-code token ("math58", "dance 152", "chem 014L") matches the
 * department + normalized number (014 ≡ 14 ≡ 114) instead of demanding the
 * exact code string. An *explicitly typed* suffix ("…014L", "…43LX") is a
 * hard constraint — "chem 014L" must not leak in the +100-numbered course
 * and "phys 30LX" must not return the lecture.
 *
 * Exported so a page can ask "which terms *do* have a match?" when the
 * selected term comes up empty (see termsWithQuery).
 */
export function buildQClause(rawQ: string): QClause | null {
  const tokens = rawQ.toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return null;
  const orParts: string[] = [];
  const orParams: (string | number | null)[] = [];

  const usedForCode = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // 'math58' / 'chem014l' / 'history101' — letters glued to a number.
    let m = /^([a-z]{2,12})\s*0*(\d{1,4})([a-z]{0,2})$/.exec(t);
    // 'dance 152' / 'history 101' / 'economics 1' — a department name (code
    // or full word) followed by a bare number. Build the same shape as the
    // glued regex: [full, dept, number, suffix]. The dept is matched
    // prefix-aware below, so 'history' resolves to the stored 'HIST'.
    if (
      !m &&
      i + 1 < tokens.length &&
      /^[a-z]{2,12}$/.test(t) &&
      /^0*\d{1,4}[a-z]{0,2}$/.test(tokens[i + 1])
    ) {
      const n = tokens[i + 1];
      const mm = /^0*(\d{1,4})([a-z]{0,2})$/.exec(n)!;
      m = [t, t, mm[1], mm[2]] as unknown as RegExpExecArray;
      usedForCode.add(i);
      usedForCode.add(i + 1);
    }
    if (m) {
      const nums = fuzzyNumbers(Number(m[2]));
      let part = `((s.department = ? OR upper(s.department) LIKE upper(?) || '%' OR upper(?) LIKE upper(s.department) || '%') AND s.course_number IN (${nums.map(() => "?").join(",")}))`;
      orParams.push(m[1].toUpperCase(), m[1], m[1], ...nums);
      if (m[3]) {
        part += " AND upper(s.suffix) = ?";
        orParams.push(m[3].toUpperCase());
      }
      orParts.push(part);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (usedForCode.has(i)) continue;
    orParts.push("s.search LIKE ?");
    orParams.push(`%${tokens[i]}%`);
  }

  if (orParts.length === 0) return null;
  return { clause: `(${orParts.join(" OR ")})`, params: orParams };
}

/**
 * Terms (besides `excludeTerm`) that contain matches for the free-text query,
 * most matches first. Lets the catalog tell a student "not offered in Fall
 * 2026 — it is in Spring 2027 (2 sections)" instead of a dead "Nothing
 * matched".
 */
export async function termsWithQuery(
  rawQ: string,
  excludeTerm?: string,
  limit = 5,
): Promise<{ term_id: string; n: number }[]> {
  const qc = buildQClause(rawQ);
  if (!qc) return [];
  const where = [qc.clause];
  const params: (string | number | null)[] = [...qc.params];
  if (excludeTerm) {
    where.push("s.term_id <> ?");
    params.push(excludeTerm);
  }
  return all<{ term_id: string; n: number }>(
    `SELECT s.term_id, COUNT(*) n FROM sections s WHERE ${where.join(" AND ")}
     GROUP BY s.term_id ORDER BY n DESC, s.term_id DESC LIMIT ?`,
    [...params, limit],
  );
}

/**
 * Course numbers a fuzzy query might mean. "chem 014L" is commonly written as
 * chem 14, chem 014 or chem 114, so a two-digit number also stands in for the
 * same course at +100, and vice versa. "dance 152" therefore also matches 052.
 */
function fuzzyNumbers(n: number): number[] {
  const out = [n];
  if (n < 100) out.push(n + 100);
  else if (n > 100) out.push(n - 100);
  return out;
}

/**
 * Senior-thesis style work (thesis, senior project, grant proposal, senior
 * research/paper/capstone/comprehensive, …). Students already know which one
 * they are taking, so browsing lists put these last — the search itself is
 * unchanged, so searching "thesis" still finds them.
 */
const THESIS_WORDS = [
  "thesis",
  "senior project",
  "senior grant",
  "senior research",
  "senior paper",
  "senior capstone",
  "senior comprehensive",
  "senior oral",
  "senior tutorial",
  "sr thesis",
  "sr research",
  "sr libry",
];
export const THESIS_TITLE_RE = new RegExp(THESIS_WORDS.join("|"), "i");
const THESIS_SQL = `(${THESIS_WORDS.map((w) => `lower(s.title) LIKE '%${w}%'`).join(" OR ")})`;

const SORTS: Record<string, string> = {
  code: "s.department ASC, s.course_number ASC, s.affiliation ASC, s.section_number ASC",
  title: "s.title ASC",
  credits: "s.credits DESC, s.department ASC",
  perm: "s.perm_count DESC, s.department ASC",
};

export async function searchSections(q: CatalogQuery): Promise<{ rows: Section[]; total: number }> {
  const { where, params } = buildWhere(q);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(q.limit ?? PAGE_DEFAULT, PAGE_MAX);
  const offset = Math.max(q.offset ?? 0, 0);
  const order = `${THESIS_SQL} ASC, ${SORTS[q.sort ?? "code"] ?? SORTS.code}`;

  // COUNT and page SELECT are independent — fire both at once.
  const [totalRow, rows] = await Promise.all([
    get<{ n: number }>(`SELECT COUNT(*) n FROM sections s ${clause}`, params),
    all<SectionRow>(
      `SELECT s.* FROM sections s ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  return { rows: await hydrate(rows), total: Number(totalRow?.n ?? 0) };
}

/** Attach meetings, instructors and course areas to a page of sections.
 *  The three lookups are independent — one parallel fan-out. */
export async function hydrate(rows: SectionRow[]): Promise<Section[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");

  const [meetings, instructors, areas] = await Promise.all([
    all<{ section_id: string } & Meeting>(
      `SELECT section_id, days, start_time, end_time, locations
       FROM section_schedules WHERE section_id IN (${ph})
       ORDER BY start_time ASC`,
      ids,
    ),
    all<{ section_id: string } & InstructorRef>(
      `SELECT si.section_id, i.id, i.name,
              ir.avg_stars, ir.review_count, ir.rmp_quality, ir.rmp_num_ratings, ir.rmp_url
       FROM section_instructors si
       JOIN instructors i ON i.id = si.instructor_id
       LEFT JOIN instructor_ratings ir ON ir.id = i.id
       WHERE si.section_id IN (${ph})
       ORDER BY i.name ASC`,
      ids,
    ),
    all<{ section_id: string } & AreaRef>(
      `SELECT sa.section_id, ca.code, ca.description, ca.kind, ca.school
       FROM section_areas sa
       JOIN course_areas ca ON ca.code = sa.area_code
       WHERE sa.section_id IN (${ph})
       ORDER BY ca.kind = 'ge' DESC, ca.code ASC`,
      ids,
    ),
  ]);

  const mBy = group(meetings, "section_id");
  const iBy = group(instructors, "section_id");
  const aBy = group(areas, "section_id");

  return rows.map((r) => ({
    ...r,
    school_short: schoolShort(r.school),
    credits_5c: r.school === "HM" ? Number((r.credits / 3).toFixed(3)) : r.credits,
    meetings: mBy.get(r.id) ?? [],
    instructors: iBy.get(r.id) ?? [],
    areas: aBy.get(r.id) ?? [],
  }));
}

function group<T extends Record<string, unknown>>(rows: T[], key: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(r[key]);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export async function getSection(id: string): Promise<Section | undefined> {
  const row = await get<SectionRow>("SELECT * FROM sections WHERE id = ?", [id]);
  return row ? (await hydrate([row]))[0] : undefined;
}

/**
 * Every section in a term, hydrated. ~2,200 rows for a 5C term.
 * Used by the sample-plan builder and the "requirements vs. catalog" audit;
 * do not call this from a page render.
 */
export async function sectionsForTerm(termId: string, openOnly = false): Promise<Section[]> {
  const rows = await all<SectionRow>(
    `SELECT * FROM sections WHERE term_id = ? ${openOnly ? "AND status IN ('O','R')" : ""}
     ORDER BY department, course_number, section_number`,
    [termId],
  );
  // Hydrate in chunks so the IN(...) lists stay well under SQLite's limit.
  const out: Section[] = [];
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    out.push(...(await hydrate(rows.slice(i, i + CHUNK))));
  }
  return out;
}

export async function getSectionsByIds(ids: string[]): Promise<Section[]> {
  if (!ids.length) return [];
  const rows: SectionRow[] = [];
  const CHUNK = 500; // keep the IN (...) list under SQLite's parameter limit
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const ph = chunk.map(() => "?").join(",");
    rows.push(...(await all<SectionRow>(`SELECT * FROM sections WHERE id IN (${ph})`, chunk)));
  }
  return hydrate(rows);
}

/* --------------------------------- facets -------------------------------- */

export type Facets = {
  /** Synced terms only, newest first. */
  terms: { id: string; label: string; is_current: number; sections: number }[];
  schools: { code: string; short: string; n: number }[];
  departments: { code: string; description: string; n: number }[];
  geAreas: { code: string; description: string; school: string | null; n: number }[];
  instructors: number;
};

// Terms and per-term section counts only change on sync, and facets() runs on
// several pages per request: memoize per request so the full-table GROUP BY
// runs at most once.
const termList = cache(() =>
  all<{ id: string; label: string; is_current: number }>(
    "SELECT id, label, is_current FROM terms ORDER BY id DESC",
  ),
);
const termSectionCounts = cache(() =>
  all<{ term_id: string; n: number }>("SELECT term_id, COUNT(*) n FROM sections GROUP BY term_id"),
);

/**
 * Facets only change when the catalog syncs, so they're cached across requests
 * (tag "catalog", 5-minute TTL as a backstop for syncs that run outside a
 * request, where the tag can't be revalidated). Dropping a Turso round-trip
 * fan-out from every catalog/planner view is the point.
 */
export const CATALOG_TAG = "catalog";
const cachedFacets = unstable_cache(
  (term: string) => facetsUncached(term || undefined),
  ["facets-v1"],
  { tags: [CATALOG_TAG], revalidate: 300 },
);
export function facets(term?: string): Promise<Facets> {
  return cachedFacets(term ?? "");
}

async function facetsUncached(term?: string): Promise<Facets> {
  const p = term ? [term] : [];
  const termClause = term ? "WHERE term_id = ?" : "";
  // The per-term section count used to be a correlated subquery (a full
  // sections scan *per term*, ~100-180ms alone); a single GROUP BY plus a
  // JS merge does the same work in one pass, and all six statements below
  // are independent — they run as one parallel fan-out.
  const [termRows, termCounts, schools, departments, geAreas, instr] = await Promise.all([
    termList(),
    termSectionCounts(),
    all<{ code: string; short: string; n: number }>(
      `SELECT school AS code, school AS short, COUNT(*) n FROM sections ${termClause} GROUP BY school ORDER BY n DESC`,
      p,
    ),
    all<{ code: string; description: string; n: number }>(
      `SELECT ca.code, ca.description, COUNT(*) n
       FROM course_areas ca
       JOIN section_areas sa ON sa.area_code = ca.code
       JOIN sections s ON s.id = sa.section_id
       ${term ? "WHERE s.term_id = ? AND" : "WHERE"} ca.kind = 'dept'
       GROUP BY ca.code ORDER BY ca.code ASC`,
      p,
    ),
    all<{ code: string; description: string; school: string | null; n: number }>(
      `SELECT ca.code, ca.description, ca.school, COUNT(*) n
       FROM course_areas ca
       JOIN section_areas sa ON sa.area_code = ca.code
       JOIN sections s ON s.id = sa.section_id
       ${term ? "WHERE s.term_id = ? AND" : "WHERE"} ca.kind = 'ge'
       GROUP BY ca.code ORDER BY ca.code ASC`,
      p,
    ),
    get<{ n: number }>("SELECT COUNT(*) n FROM instructors"),
  ]);
  // Only terms we actually hold a catalog for, newest first in calendar order
  // (a string compare puts every Spring after every Fall).
  const countBy = new Map(termCounts.map((r) => [r.term_id, Number(r.n)]));
  const terms = termRows
    .map((t) => ({ ...t, sections: countBy.get(t.id) ?? 0 }))
    .filter((t) => t.sections > 0)
    .sort((a, b) => termChronoKey(b.id) - termChronoKey(a.id));
  return {
    terms,
    schools,
    departments,
    geAreas,
    instructors: Number(instr?.n ?? 0),
  };
}

/** Instructor autocomplete for the review + filter UIs. */
export async function suggestInstructors(prefix: string, limit = 12) {
  return all<{ id: string; name: string; section_count: number }>(
    `SELECT id, name, section_count FROM instructors
     WHERE normalized LIKE ? ORDER BY section_count DESC, name ASC LIMIT ?`,
    [`%${prefix.toLowerCase().trim()}%`, limit],
  );
}
