/**
 * Ingest HyperSchedule's live v4 feed into our SQLite catalog and extend it
 * with the things a planner needs (instructor identity, GE-vs-department
 * course areas, full-text search haystack).
 */
import { notifyOpenings, seatOpened } from "./notify";
import { all, get, newId, nowIso, run, setMeta, tx } from "./db";
import {
  getAllTerms,
  getCourseAreas,
  getSections,
  termChronoKey,
  termIdOf,
  type HS_Section,
  type HS_Term,
} from "./hyperschedule";
import { SCHOOL_BY_CODE } from "./constants";
import { cache } from "react";
import {
  buildCodeString,
  buildCourseCode,
  buildSectionId,
  formatCourseNumber,
  normalizeName,
  sortDays,
  termLabel,
} from "./util";

/** 1x=Pomona, 2x=Scripps, 3x=CMC, 4x=HMC, 5x=Pitzer registrar GE families. */
const GE_PREFIX_SCHOOL: Record<string, string> = {
  "1": "PO",
  "2": "SC",
  "3": "CM",
  "4": "HM",
  "5": "PZ",
};

export function areaSchool(code: string): string | null {
  return GE_PREFIX_SCHOOL[code[0]] ?? null;
}

export function areaKind(code: string): "ge" | "dept" {
  return /^\d/.test(code) ? "ge" : "dept";
}

export type SyncReport = {
  term: string;
  sections: number;
  instructors: number;
  meetings: number;
  areaLinks: number;
  /** Sections that existed last sync and are no longer offered upstream. */
  dropped?: number;
  ms: number;
};

/* ------------------------------ course areas ----------------------------- */

export async function syncCourseAreasFrom(upstream: { area: string; description: string }[]) {
  return tx(async () => {
    for (const a of upstream) {
      await run(
        `INSERT INTO course_areas(code, description, school, kind)
         VALUES(?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET
           description = excluded.description,
           school = excluded.school,
           kind = excluded.kind`,
        [a.area, a.description, areaSchool(a.area), areaKind(a.area)],
      );
    }
    await setMeta("course_areas_synced_at", nowIso());
    return upstream.length;
  });
}

export async function syncCourseAreas(force = false) {
  const areas = await getCourseAreas(force);
  const n = await syncCourseAreasFrom(areas);
  // Make sure every code that actually shows up on a section exists too.
  const orphans = await all<{ area_code: string }>(
    `SELECT DISTINCT sa.area_code FROM section_areas sa
     LEFT JOIN course_areas ca ON ca.code = sa.area_code
     WHERE ca.code IS NULL`,
  );
  for (const o of orphans) {
    await run("INSERT OR IGNORE INTO course_areas(code, description, school, kind) VALUES(?,?,?,?)", [
      o.area_code,
      o.area_code,
      areaSchool(o.area_code),
      areaKind(o.area_code),
    ]);
  }
  return n;
}

/* --------------------------------- terms -------------------------------- */

/**
 * Ensure a term row exists so section FKs resolve. `is_current` is only
 * written for brand-new rows — the term-list sync (syncTermListFrom) is the
 * sole owner of that flag for existing rows, so ingesting the current term
 * cannot clobber it back to 0.
 */
export async function upsertTerm(termId: string, isCurrent: boolean) {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(termId);
  if (!m) throw new Error(`bad term id ${termId}`);
  await run(
    `INSERT INTO terms(id, year, term, label, is_current, synced_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       synced_at = excluded.synced_at,
       label = excluded.label`,
    [termId, Number(m[2]), m[1], termLabel(termId), isCurrent ? 1 : 0, nowIso()],
  );
}

/**
 * The current term is decided by the calendar, not by what the registrar
 * feed calls "current": at the 5Cs, Fall (FA{year}) runs July–December and
 * Spring (SP{year}) runs January–June. In November the feed is already
 * advertising Spring registration, but the term students are actually in
 * is still Fall.
 */
export function seasonalTermId(d: Date = new Date()): string {
  const month = d.getMonth() + 1; // 1 = Jan … 12 = Dec
  return month >= 7 ? `FA${d.getFullYear()}` : `SP${d.getFullYear()}`;
}

/** Store an already-fetched upstream term list (used by auto-sync). */
export async function syncTermListFrom(terms: HS_Term[]) {
  const currentId = seasonalTermId();
  await tx(async () => {
    for (const t of terms) {
      const id = termIdOf(t);
      const exists = await get<{ id: string }>("SELECT id FROM terms WHERE id = ?", [id]);
      if (exists) {
        await run("UPDATE terms SET is_current = ? WHERE id = ?", [id === currentId ? 1 : 0, id]);
      } else {
        await run("INSERT INTO terms(id, year, term, label, is_current) VALUES(?,?,?,?,?)", [
          id,
          t.year,
          t.term,
          termLabel(id),
          id === currentId ? 1 : 0,
        ]);
      }
    }
    // The seasonal term is the sole owner of the flag. Make sure its row
    // exists even when upstream hasn't listed it yet, and clear any stale
    // flags (e.g. last season's term dropping off the list).
    await upsertTerm(currentId, true);
    await run("UPDATE terms SET is_current = 0 WHERE is_current = 1 AND id != ?", [currentId]);
    await setMeta("current_term", currentId);
    await setMeta("terms_synced_at", nowIso());
  });
  return { currentId, count: terms.length };
}

/** Refresh the term list we offer in the UI, from /v4/term/all. */
export async function syncTermList(force = false) {
  return await syncTermListFrom(await getAllTerms(force));
}

async function loadCurrentTermId(): Promise<string> {
  // The calendar wins: once the seasonal term's row exists, every page is on
  // the right term immediately — even before the first sync after a
  // season change flips the is_current flag.
  const seasonal = seasonalTermId();
  if ((await get<{ id: string }>("SELECT id FROM terms WHERE id = ?", [seasonal]))?.id) return seasonal;
  return (
    (await getMetaSafe("current_term")) ??
    (await get<{ id: string }>("SELECT id FROM terms WHERE is_current = 1 ORDER BY id DESC LIMIT 1"))
      ?.id ??
    (await get<{ id: string }>("SELECT id FROM terms ORDER BY id DESC LIMIT 1"))?.id ??
    ""
  );
}

// cache(): one request (layout + page + nested components) may resolve the
// current term several times; the per-request memo keeps it to one query.
// Sync/bootstrap paths use loadCurrentTermId() directly so they never read a
// value memoized before they changed the terms table.
export const currentTermId: () => Promise<string> = cache(loadCurrentTermId);

async function getMetaSafe(key: string): Promise<string | undefined> {
  try {
    return (await get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]))?.value;
  } catch {
    return undefined;
  }
}

/* ------------------------------- sections ------------------------------- */

async function upsertInstructor(name: string, school: string): Promise<string> {
  const normalized = normalizeName(name);
  if (!normalized) return "";
  const existing = await get<{ id: string; home_school: string | null }>(
    "SELECT id, home_school FROM instructors WHERE normalized = ?",
    [normalized],
  );
  if (existing) {
    if (!existing.home_school && school) {
      await run("UPDATE instructors SET home_school = ? WHERE id = ?", [school, existing.id]);
    }
    return existing.id;
  }
  const id = "ins-" + normalized.replace(/[^a-z0-9]+/g, "-").slice(0, 48) + "-" + newId().slice(0, 6);
  await run(
    "INSERT INTO instructors(id, name, normalized, home_school) VALUES(?,?,?,?)",
    [id, name.trim(), normalized, school || null],
  );
  return id;
}

/** Pure transform: one upstream section -> our rows. */
export function sectionToRows(s: HS_Section, termId: string) {
  const id = buildSectionId({
    department: s.identifier.department,
    courseNumber: s.identifier.courseNumber,
    suffix: s.identifier.suffix,
    affiliation: s.identifier.affiliation,
    sectionNumber: s.identifier.sectionNumber,
    term: termId,
  });

  const courseCode = buildCourseCode({
    department: s.identifier.department,
    courseNumber: s.identifier.courseNumber,
    suffix: s.identifier.suffix,
    affiliation: s.identifier.affiliation,
  });

  const codeString = buildCodeString({
    department: s.identifier.department,
    courseNumber: s.identifier.courseNumber,
    suffix: s.identifier.suffix,
    affiliation: s.identifier.affiliation,
    sectionNumber: s.identifier.sectionNumber,
    term: termId,
  });

  const half = s.identifier.half
    ? `${s.identifier.half.prefix}${s.identifier.half.number}`
    : null;

  const iso = (d: { year: number; month: number; day: number }) =>
    `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

  const instNames = s.instructors.map((i) => i.name).filter(Boolean);

  const sectionRow = {
    id,
    term_id: termId,
    department: s.identifier.department,
    course_number: s.identifier.courseNumber,
    suffix: s.identifier.suffix ?? "",
    affiliation: s.identifier.affiliation,
    section_number: s.identifier.sectionNumber,
    half,
    code_string: codeString,
    course_code: courseCode,
    title: (s.course.title || "").trim(),
    description: (s.course.description || "").trim(),
    school: s.course.primaryAssociation,
    credits: s.credits,
    perm_count: s.permCount,
    seats_total: s.seatsTotal,
    seats_filled: s.seatsFilled,
    status: s.status,
    start_date: s.startDate ? iso(s.startDate) : null,
    end_date: s.endDate ? iso(s.endDate) : null,
    potential_error: s.potentialError || s.course.potentialError ? 1 : 0,
  };

  const search = [
    sectionRow.department,
    formatCourseNumber(sectionRow.course_number) + sectionRow.suffix,
    sectionRow.title,
    sectionRow.description,
    instNames.join(" "),
    s.courseAreas.join(" "),
    SCHOOL_BY_CODE[sectionRow.school]?.short ?? "",
    courseCode,
  ]
    .join(" ")
    .toLowerCase();

  const meetings = s.schedules.map((m) => ({
    days: sortDays((m.days ?? []).join("")),
    start_time: m.startTime,
    end_time: m.endTime,
    locations: (m.locations ?? []).filter(Boolean).join(" · "),
  }));

  return { sectionRow, meetings, instNames, areas: s.courseAreas, search };
}

/**
 * Denormalized teaching load, used to rank the professor directory. Must be
 * recomputed across *every* synced term: an instructor who also teaches in
 * another term's catalog would otherwise be zeroed out by this term's sync.
 */
async function recomputeSectionCounts() {
  await run("UPDATE instructors SET section_count = 0");
  for (const r of await all<{ instructor_id: string; n: number }>(
    "SELECT instructor_id, COUNT(*) n FROM section_instructors GROUP BY instructor_id",
  )) {
    await run("UPDATE instructors SET section_count = ? WHERE id = ?", [r.n, r.instructor_id]);
  }
}

type BuiltSection = ReturnType<typeof sectionToRows>;

/**
 * Write one section (row + meetings + instructors + areas). Child rows must
 * already be cleared for this section. Shared by the full term ingest and the
 * incremental refresh so both always store exactly the same thing.
 */
async function writeSection(
  b: BuiltSection,
  touchedInstructors: Set<string>,
): Promise<{ meetings: number; areaLinks: number }> {
  const { sectionRow, meetings: ms, instNames, areas, search } = b;
  let meetings = 0;
  let areaLinks = 0;
  await run(
    // NOT `INSERT OR REPLACE`: SQLite resolves a conflict that way by
    // DELETE-ing the row first, and enrollments/reviews hang off
    // sections(id) ON DELETE CASCADE — so a routine re-sync of a section a
    // student had planned would silently drop their enrollment. Upsert in
    // place instead.
    `INSERT INTO sections(
       id, term_id, department, course_number, suffix, affiliation, section_number, half,
       code_string, course_code, title, description, school, credits, perm_count,
       seats_total, seats_filled, status, start_date, end_date, potential_error, search)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       department = excluded.department,
       course_number = excluded.course_number,
       suffix = excluded.suffix,
       affiliation = excluded.affiliation,
       section_number = excluded.section_number,
       half = excluded.half,
       code_string = excluded.code_string,
       course_code = excluded.course_code,
       title = excluded.title,
       description = excluded.description,
       school = excluded.school,
       credits = excluded.credits,
       perm_count = excluded.perm_count,
       seats_total = excluded.seats_total,
       seats_filled = excluded.seats_filled,
       status = excluded.status,
       start_date = excluded.start_date,
       end_date = excluded.end_date,
       potential_error = excluded.potential_error,
       search = excluded.search`,
    [
      sectionRow.id,
      sectionRow.term_id,
      sectionRow.department,
      sectionRow.course_number,
      sectionRow.suffix,
      sectionRow.affiliation,
      sectionRow.section_number,
      sectionRow.half,
      sectionRow.code_string,
      sectionRow.course_code,
      sectionRow.title,
      sectionRow.description,
      sectionRow.school,
      sectionRow.credits,
      sectionRow.perm_count,
      sectionRow.seats_total,
      sectionRow.seats_filled,
      sectionRow.status,
      sectionRow.start_date,
      sectionRow.end_date,
      sectionRow.potential_error,
      search,
    ],
  );
    for (const m of ms) {
    await run(
      `INSERT INTO section_schedules(section_id, days, start_time, end_time, locations)
       VALUES(?,?,?,?,?)`,
      [sectionRow.id, m.days, m.start_time, m.end_time, m.locations],
    );
    meetings++;
  }

  for (const name of instNames) {
    const iid = await upsertInstructor(name, sectionRow.school);
    if (!iid) continue;
    await run("INSERT OR IGNORE INTO section_instructors(section_id, instructor_id) VALUES(?,?)", [
      sectionRow.id,
      iid,
    ]);
    touchedInstructors.add(iid);
  }

  for (const a of areas) {
    await run("INSERT OR IGNORE INTO course_areas(code, description, school, kind) VALUES(?,?,?,?)", [
      a,
      a,
      areaSchool(a),
      areaKind(a),
    ]);
    await run("INSERT OR IGNORE INTO section_areas(section_id, area_code) VALUES(?,?)", [
      sectionRow.id,
      a,
    ]);
    areaLinks++;
  }
  return { meetings, areaLinks };
}

export async function ingestSections(upstream: HS_Section[], termId: string): Promise<SyncReport> {
  const t0 = Date.now();
  let sections = 0;
  let meetings = 0;
  let areaLinks = 0;
  let dropped = 0;
  const touchedInstructors = new Set<string>();

  // Convert up front: we need the incoming id set before we touch the database.
  const built = upstream.map((s) => sectionToRows(s, termId));
  const incoming = new Set(built.map((b) => b.sectionRow.id));

  await tx(async () => {
    await upsertTerm(termId, false);
    // An empty payload is treated as an upstream failure, not as "this term has
    // no courses". Rewriting a real term is safe; blanking it is not.
    if (incoming.size === 0) {
      console.warn(`[sync] ${termId}: upstream returned 0 sections, leaving catalog untouched`);
      return;
    }
    // Seat counts, times and perm availability change constantly during
    // registration, so mutable rows are rewritten. But we must NOT `DELETE FROM
    // sections WHERE term_id = ?`: enrollments and reviews reference
    // sections(id) ON DELETE CASCADE, so a wholesale delete silently wipes every
    // student's saved plan for that term on every sync. Only sections upstream
    // actually dropped go away — a course that stopped being offered *should*
    // leave the plan.
    const vanished = (
      await all<{ id: string }>("SELECT id FROM sections WHERE term_id = ?", [
        termId,
      ])
    ).filter((r) => !incoming.has(r.id));
    const goneIds = vanished.map((r) => r.id);
    if (goneIds.length > 0) {
      const ph = goneIds.map(() => "?").join(",");
      // enrollments + requirement_assignments cascade; reviews SET NULL
      await run(`DELETE FROM enrollments WHERE section_id IN (${ph})`, goneIds);
      await run(`DELETE FROM requirement_assignments WHERE section_id IN (${ph})`, goneIds);
      await run(`UPDATE reviews SET section_id = NULL WHERE section_id IN (${ph})`, goneIds);
      await run(`DELETE FROM sections WHERE id IN (${ph})`, goneIds);
    }
    dropped = goneIds.length;

    for (const table of ["section_instructors", "section_areas", "section_schedules"]) {
      // Child rows carry no user data; rebuild them for the surviving sections.
      await run(
        `DELETE FROM ${table} WHERE section_id IN (SELECT id FROM sections WHERE term_id = ?)`,
        [termId],
      );
    }
    for (const b of built) {
      const r = await writeSection(b, touchedInstructors);
      sections++;
      meetings += r.meetings;
      areaLinks += r.areaLinks;
    }

    await recomputeSectionCounts();

    await setMeta(`synced_${termId}`, nowIso());
  });

  return {
    term: termId,
    sections,
    instructors: touchedInstructors.size,
    meetings,
    areaLinks,
    dropped,
    ms: Date.now() - t0,
  };
}

export type RefreshReport = {
  term: string;
  status: "unchanged" | "patched" | "full" | "skipped";
  /** Sections whose seats, perms, times, locations, instructors … changed. */
  changed: number;
  added: number;
  removed: number;
  ms: number;
};

/** Everything about a section a student can see, as one comparable string. */
function signature(b: BuiltSection, instNorm: string[]): string {
  const r = b.sectionRow;
  return JSON.stringify([
    r.title, r.description, r.credits, r.perm_count, r.seats_total, r.seats_filled, r.status,
    r.start_date, r.end_date, r.potential_error, r.half, r.school, r.code_string,
    b.meetings.map((m) => `${m.days}|${m.start_time}|${m.end_time}|${m.locations}`).sort(),
    [...instNorm].sort(),
    [...b.areas].sort(),
  ]);
}

/**
 * Incremental refresh: re-read the live upstream term and rewrite ONLY the
 * sections that actually changed — seats, perm counts, status, meeting days /
 * times / locations, instructors, areas, titles, descriptions, credits.
 * Typically a handful of rows, so it is cheap enough to run every few minutes
 * (even over the network to Turso). If sections were added or dropped upstream
 * it falls back to the full term ingest, which also creates profiles for new
 * professors.
 */
export async function refreshTerm(termId: string): Promise<RefreshReport> {
  const t0 = Date.now();
  const upstream = await getSections(termId, true);
  const done = (status: RefreshReport["status"], changed = 0, added = 0, removed = 0): RefreshReport => ({
    term: termId, status, changed, added, removed, ms: Date.now() - t0,
  });
  if (upstream.length === 0) return done("skipped"); // an empty payload is a failure, not "no courses"

  const built = upstream.map((s) => sectionToRows(s, termId));
  const [rows, sched, inst, areas] = await Promise.all([
    all<Record<string, string | number | null>>(
      `SELECT id, title, description, credits, perm_count, seats_total, seats_filled, status,
              start_date, end_date, potential_error, half, school, code_string
       FROM sections WHERE term_id = ?`,
      [termId],
    ),
    all<{ section_id: string; days: string; start_time: number; end_time: number; locations: string }>(
      `SELECT ss.section_id, ss.days, ss.start_time, ss.end_time, ss.locations
       FROM section_schedules ss JOIN sections s ON s.id = ss.section_id WHERE s.term_id = ?`,
      [termId],
    ),
    all<{ section_id: string; normalized: string }>(
      `SELECT si.section_id, i.normalized FROM section_instructors si
       JOIN instructors i ON i.id = si.instructor_id JOIN sections s ON s.id = si.section_id
       WHERE s.term_id = ?`,
      [termId],
    ),
    all<{ section_id: string; area_code: string }>(
      `SELECT sa.section_id, sa.area_code FROM section_areas sa
       JOIN sections s ON s.id = sa.section_id WHERE s.term_id = ?`,
      [termId],
    ),
  ]);

  // Full classes that gained a seat (checked against the pre-update rows, so it
  // also holds when the update takes the full-rewrite path below).
  const opened: string[] = [];
  {
    const before = new Map(rows.map((r) => [r.id as string, r]));
    for (const b of built) {
      const r = before.get(b.sectionRow.id);
      if (!r) continue;
      if (
        seatOpened(
          { seats_total: Number(r.seats_total), seats_filled: Number(r.seats_filled), perm_count: Number(r.perm_count) },
          {
            seats_total: Number(b.sectionRow.seats_total),
            seats_filled: Number(b.sectionRow.seats_filled),
            perm_count: Number(b.sectionRow.perm_count),
          },
        )
      )
        opened.push(b.sectionRow.id);
    }
  }
  const dbIds = new Set(rows.map((r) => r.id as string));
  const incoming = new Set(built.map((b) => b.sectionRow.id));
  const added = built.filter((b) => !dbIds.has(b.sectionRow.id)).length;
  const removed = [...dbIds].filter((id) => !incoming.has(id)).length;
  if (added > 0 || removed > 0) {
    const r = await ingestSections(upstream, termId);
    await syncCourseAreas(false);
    await notifyOpenings(opened).catch(() => 0);
    return { term: termId, status: "full", changed: r.sections, added, removed, ms: Date.now() - t0 };
  }

  const group = <T extends { section_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) (m.get(x.section_id) ?? m.set(x.section_id, []).get(x.section_id)!).push(x);
    return m;
  };
  const schedBy = group(sched);
  const instBy = group(inst);
  const areaBy = group(areas);
  const rowBy = new Map(rows.map((r) => [r.id as string, r]));

  const changed: BuiltSection[] = [];
  for (const b of built) {
    const r = rowBy.get(b.sectionRow.id)!;
    const dbBuilt = {
      sectionRow: {
        ...b.sectionRow,
        title: r.title, description: r.description, credits: r.credits, perm_count: r.perm_count,
        seats_total: r.seats_total, seats_filled: r.seats_filled, status: r.status,
        start_date: r.start_date, end_date: r.end_date, potential_error: r.potential_error,
        half: r.half, school: r.school, code_string: r.code_string,
      },
      meetings: (schedBy.get(b.sectionRow.id) ?? []).map((m) => ({
        days: m.days, start_time: m.start_time, end_time: m.end_time, locations: m.locations,
      })),
      areas: (areaBy.get(b.sectionRow.id) ?? []).map((a) => a.area_code),
    } as unknown as BuiltSection;
    const dbInst = (instBy.get(b.sectionRow.id) ?? []).map((x) => x.normalized);
    const upInst = b.instNames.map((n) => normalizeName(n)).filter(Boolean);
    if (signature(dbBuilt, dbInst) !== signature(b, upInst)) changed.push(b);
  }

  if (changed.length > 0) {
    await tx(async () => {
      const touched = new Set<string>();
      for (const b of changed) {
        for (const table of ["section_instructors", "section_areas", "section_schedules"]) {
          await run(`DELETE FROM ${table} WHERE section_id = ?`, [b.sectionRow.id]);
        }
        await writeSection(b, touched);
      }
      await recomputeSectionCounts();
    });
  }
  await notifyOpenings(opened).catch(() => 0);
  return done(changed.length ? "patched" : "unchanged", changed.length);
}

/** Download + store one term. */
export async function syncTerm(termId: string, force = true): Promise<SyncReport> {
  const sections = await getSections(termId, force);
  const report = await ingestSections(sections, termId);
  await syncCourseAreas(false);
  return report;
}

/**
 * First-run bootstrap: term list, current term, the current term's catalog and
 * the next term (the one students are actually registering for).
 */
export async function bootstrap(): Promise<{
  current: string;
  reports: SyncReport[];
}> {
  await syncTermList(true);
  const current = await loadCurrentTermId();
  // Newest first in *calendar* order: string-sorting term ids puts every Spring
  // after every Fall, which silently skips the term students are actually in.
  const available = (await all<{ id: string }>("SELECT id FROM terms"))
    .map((r) => r.id)
    .sort((a, b) => termChronoKey(b) - termChronoKey(a));
  // The current term, then the newest ones listed (registration) and the most
  // recent past term, so transcripts and year-long plans both resolve.
  const wanted = Array.from(new Set([current, ...available])).slice(0, 3);
  const reports: SyncReport[] = [];
  for (const t of wanted) {
    try {
      reports.push(await syncTerm(t, true));
    } catch (err) {
      console.error(`[sync] ${t} failed:`, (err as Error).message);
    }
  }
  return { current, reports };
}

// Six scalar counts ride in ONE statement (they used to be six serial
// round-trips), and the two row sets run in parallel with it.
export async function catalogStats() {
  const [counts, terms, bySchool] = await Promise.all([
    get<{
      sections: number;
      courses: number;
      instructors: number;
      areas: number;
      reviews: number;
      users: number;
    }>(
      `SELECT (SELECT COUNT(*) FROM sections) AS sections,
              (SELECT COUNT(DISTINCT course_code) FROM sections) AS courses,
              (SELECT COUNT(*) FROM instructors) AS instructors,
              (SELECT COUNT(*) FROM course_areas) AS areas,
              (SELECT COUNT(*) FROM reviews) AS reviews,
              (SELECT COUNT(*) FROM users) AS users`,
    ),
    all<{ id: string; label: string; is_current: number; synced_at: string | null }>(
      "SELECT id, label, is_current, synced_at FROM terms ORDER BY id DESC",
    ),
    all<{ school: string; n: number }>(
      "SELECT school, COUNT(*) n FROM sections GROUP BY school ORDER BY n DESC",
    ),
  ]);
  return {
    sections: Number(counts?.sections ?? 0),
    courses: Number(counts?.courses ?? 0),
    instructors: Number(counts?.instructors ?? 0),
    areas: Number(counts?.areas ?? 0),
    terms,
    reviews: Number(counts?.reviews ?? 0),
    users: Number(counts?.users ?? 0),
    bySchool,
  };
}
