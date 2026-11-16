/**
 * Requirement engine.
 *
 * Requirement *definitions* live in editable JSON under data/requirements/ and
 * are mirrored into SQLite so the UI can query them. Requirement *satisfaction*
 * is computed from the student's planned courses.
 *
 * Assigning courses to requirement slots is a bipartite matching problem (a
 * course often qualifies for several slots), so instead of naive first-come
 * matching we run Kuhn's algorithm to maximise the number of slots filled.
 * That's what lets us tell a student "you have the right number of classes but
 * two of them are needed in the same slot".
 *
 * Counting policy (most 5C campuses):
 *  - one course may tick boxes in several SETS at once (GE + major + minor);
 *  - inside a set, each course fills one slot per requirement, except
 *    Educational-Objective / Breadth-of-Knowledge groups, which may take a
 *    course that already counts elsewhere in the same set (double-dip);
 *  - a 0.5-credit course does NOT satisfy a GE or Breadth box (a full credit
 *    is needed), but its credits still count toward the graduation total.
 */
import fs from "node:fs";
import path from "node:path";
import { all, get, newId, nowIso, run, tx } from "./db";
import type { SchoolCode } from "./constants";
import type {
  GroupProgress,
  Matcher,
  ManualCourse,
  ManualCourseKind,
  RequirementGroup,
  RequirementSet,
  Section,
  SetProgress,
} from "./types";
import { schoolShort, termLabel as termLabelOf } from "./util";

const REQ_DIR = path.join(process.cwd(), "data", "requirements");

/* ========================================================================= */
/* Matching                                                                  */
/* ========================================================================= */

function normCode(c: string): string {
  return c.toUpperCase().replace(/\s+/g, " ").trim();
}

/** Does a term-independent course code like "CSCI 081 CM" refer to this section? */
function codeEquals(sectionCourseCode: string, wanted: string): boolean {
  const a = normCode(sectionCourseCode);
  const b = normCode(wanted);
  if (!a || !b) return false;
  if (a === b) return true;

  // Band matcher: "CSCI 1*" matches any "CSCI 1xx [AFF]".
  if (b.endsWith("*")) return a.startsWith(b.slice(0, -1));

  // Both sides parse as "DEPT NUM [AFF]"; section numbers are zero-padded,
  // matcher numbers may not be ("CSCI 81" === "CSCI 081 CM").
  const ma = /^([A-Z0-9&+-]+)\s+(\d+[A-Z]*)(?:\s+([A-Z]{2}))?$/.exec(a);
  const mb = /^([A-Z0-9&+-]+)\s+(\d+[A-Z]*)(?:\s+([A-Z]{2}))?$/.exec(b);
  if (!ma || !mb) return false;
  if (ma[1] !== mb[1]) return false;
  if (normNum(ma[2]) !== normNum(mb[2])) return false;
  // A matcher that pins an affiliation must match it; otherwise any counts.
  return !mb[3] || mb[3] === ma[3];
}

/** Normalize a course number for comparison: "081" === "81"; letter suffixes kept. */
function normNum(n: string): string {
  const m = /^(\d+)([A-Z]*)$/.exec(n);
  return m ? String(Number(m[1])) + m[2] : n;
}

export function matchSection(m: Matcher, s: Section): boolean {
  switch (m.type) {
    case "area":
      return s.areas.some(
        (a) =>
          m.codes
            .map(normCode)
            .some(
              (c) =>
                c === normCode(a.code) ||
                (c.endsWith("*") && normCode(a.code).startsWith(c.slice(0, -1))),
            ),
      );
    case "course":
      return m.codes.some((c) => codeEquals(s.course_code, c));
    case "department": {
      if (normCode(s.department) !== normCode(m.department)) return false;
      if (typeof m.min === "number" && s.course_number < m.min) return false;
      if (typeof m.max === "number" && s.course_number > m.max) return false;
      if (m.schools?.length && !m.schools.includes(s.school)) return false;
      return true;
    }
    case "any":
      return m.schools?.length ? m.schools.includes(s.school) : true;
    case "titleKeyword": {
      const hay = `${s.title} ${s.description}`.toLowerCase();
      return m.keywords.some((k) => hay.includes(k.toLowerCase()));
    }
    case "and":
      return m.children.every((c) => matchSection(c, s));
    case "or":
      return m.children.some((c) => matchSection(c, s));
    case "not":
      return !matchSection(m.child, s);
    default:
      return false;
  }
}

export function groupMatches(g: RequirementGroup, s: Section): boolean {
  // A group is satisfied by a section if ANY of its rules match.
  return g.rules.some((r) => matchSection(r.match, s));
}

/* ========================================================================= */
/* Loading definitions from JSON                                             */
/* ========================================================================= */

type GroupSpec = {
  id?: string;
  name: string;
  minCourses?: number;
  minCredits?: number;
  required?: boolean;
  level?: "intro" | "upper" | "any";
  notes?: string;
  /** Registrar course-area designations, e.g. ["3HUS","3HEU"] */
  area?: string[];
  /** Term-independent course codes, e.g. ["CSCI 081 CM"] */
  courses?: string[];
  /** Department buckets, e.g. [{department:"CSCI",min:100}] */
  departments?: { department: string; min?: number; max?: number; schools?: string[] }[];
  titleKeywords?: string[];
  any?: boolean;
  /** Exclusions applied on top of the positive rules. */
  exclude?: { area?: string[]; courses?: string[]; departments?: GroupSpec["departments"] };
  /** Extra explicit matchers for anything the sugar above can't express. */
  matchers?: Matcher[];
};

type SetSpec = {
  id: string;
  school: string;
  kind: "ge" | "major" | "minor";
  name: string;
  degreeYears?: number;
  totalCredits?: number;
  notes?: string;
  source?: string;
  verified?: boolean;
  groups: GroupSpec[];
};

type FileSpec = { sets: SetSpec[] };

function compileRules(g: GroupSpec): Matcher[] {
  const positives: Matcher[] = [];
  if (g.area?.length) positives.push({ type: "area", codes: g.area });
  if (g.courses?.length) positives.push({ type: "course", codes: g.courses });
  for (const d of g.departments ?? []) {
    positives.push({
      type: "department",
      department: d.department,
      min: d.min,
      max: d.max,
      schools: d.schools as never,
    });
  }
  if (g.titleKeywords?.length) positives.push({ type: "titleKeyword", keywords: g.titleKeywords });
  if (g.any) positives.push({ type: "any" });
  for (const m of g.matchers ?? []) positives.push(m);

  const neg: Matcher[] = [];
  if (g.exclude?.area?.length) neg.push({ type: "area", codes: g.exclude.area });
  if (g.exclude?.courses?.length) neg.push({ type: "course", codes: g.exclude.courses });
  for (const d of g.exclude?.departments ?? []) {
    neg.push({
      type: "department",
      department: d.department,
      min: d.min,
      max: d.max,
      schools: d.schools as never,
    });
  }

  if (!positives.length) positives.push({ type: "any" });
  if (!neg.length) return positives;
  return positives.map((p) => ({
    type: "and" as const,
    children: [p, ...neg.map((n) => ({ type: "not" as const, child: n }))],
  }));
}

/**
 * For a given set id the LAST file wins (ON CONFLICT DO UPDATE), so load order
 * is part of the semantics. The legacy, pre-catalog `majors.json` must load
 * first and the school-specific `majors-<code>.json` (upgraded from the
 * published catalogs) must load last, or the legacy ids would silently
 * overwrite the improved ones.
 */
function fileRank(f: string): number {
  if (f === "majors.json") return 0;
  if (f.startsWith("majors-")) return 2;
  return 1;
}

export function loadRequirementFiles(dir = REQ_DIR): { sets: number; groups: number } {
  if (!fs.existsSync(dir)) return { sets: 0, groups: 0 };
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((x, y) => fileRank(x) - fileRank(y) || x.localeCompare(y));

  let sets = 0;
  let groups = 0;

  tx(() => {
    for (const file of files) {
      let parsed: FileSpec;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as FileSpec;
      } catch (err) {
        throw new Error(`Bad JSON in data/requirements/${file}: ${(err as Error).message}`);
      }
      for (const spec of parsed.sets ?? []) {
        run(
          `INSERT INTO requirement_sets(id, school, kind, name, degree_years, total_credits, notes, source, verified)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             school=excluded.school, kind=excluded.kind, name=excluded.name,
             degree_years=excluded.degree_years, total_credits=excluded.total_credits,
             notes=excluded.notes, source=excluded.source, verified=excluded.verified`,
          [
            spec.id,
            spec.school,
            spec.kind,
            spec.name,
            spec.degreeYears ?? null,
            spec.totalCredits ?? null,
            spec.notes ?? null,
            spec.source ?? `data/requirements/${file}`,
            spec.verified ? 1 : 0,
          ],
        );
        sets++;
        run("DELETE FROM requirement_groups WHERE set_id = ?", [spec.id]);

        (spec.groups ?? []).forEach((g, i) => {
          const gid = `${spec.id}::${g.id ?? slug(g.name) ?? i}`;
          run(
            `INSERT INTO requirement_groups(id, set_id, name, position, min_courses, min_credits, required, level, notes)
             VALUES(?,?,?,?,?,?,?,?,?)`,
            [
              gid,
              spec.id,
              g.name,
              i,
              g.minCourses ?? (g.minCredits ? null : 1),
              g.minCredits ?? null,
              g.required === false ? 0 : 1,
              g.level ?? "any",
              g.notes ?? null,
            ],
          );
          groups++;
          for (const m of compileRules(g)) {
            run("INSERT INTO requirement_rules(group_id, match) VALUES(?,?)", [
              gid,
              JSON.stringify(m),
            ]);
          }
        });
      }
    }
    run(
      `INSERT INTO meta(key,value) VALUES('requirements_loaded_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [new Date().toISOString()],
    );
  });

  return { sets, groups };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function requirementsLoaded(): boolean {
  return Number(get<{ n: number }>("SELECT COUNT(*) n FROM requirement_sets")?.n ?? 0) > 0;
}

/* ========================================================================= */
/* Reading definitions                                                       */
/* ========================================================================= */

export function getSet(setId: string): RequirementSet | undefined {
  const set = get<Omit<RequirementSet, "groups">>("SELECT * FROM requirement_sets WHERE id = ?", [
    setId,
  ]);
  if (!set) return undefined;
  return { ...set, groups: getGroups(setId) };
}

function getGroups(setId: string): RequirementGroup[] {
  const groups = all<
    Omit<RequirementGroup, "rules"> & { rule_json: string | null }
  >(
    `SELECT g.*, (
        SELECT json_group_array(r.match) FROM requirement_rules r WHERE r.group_id = g.id
     ) AS rule_json
     FROM requirement_groups g WHERE g.set_id = ? ORDER BY g.position ASC`,
    [setId],
  );
  return groups.map((g) => {
    const { rule_json, ...rest } = g;
    let raw: (string | null)[] = [];
    try {
      raw = rule_json ? (JSON.parse(rule_json) as (string | null)[]) : [];
    } catch {
      raw = [];
    }
    return {
      ...rest,
      rules: raw
        .filter(Boolean)
        .map((json, i) => ({ id: i, match: JSON.parse(json as string) as Matcher })),
    };
  });
}

export function listSets(filter: { school?: string; kind?: string } = {}): RequirementSet[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.school) {
    where.push("school = ?");
    params.push(filter.school);
  }
  if (filter.kind) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = all<RequirementSet>(
    `SELECT * FROM requirement_sets ${clause} ORDER BY kind ASC, name ASC`,
    params,
  );
  return rows.map((r) => ({ ...r, groups: getGroups(r.id) }));
}

export type UserPrograms = {
  school: string;
  major_id: string | null;
  /** Double major — tracked with the same engine as the first major. */
  major2_id?: string | null;
  minor_id: string | null;
};

export function setsForUser(u: UserPrograms): RequirementSet[] {
  const ids = [
    `ge-${u.school}`,
    u.major_id,
    u.major2_id ?? null,
    u.minor_id,
  ].filter(Boolean) as string[];
  const out: RequirementSet[] = [];
  for (const id of ids) {
    const s = getSet(id);
    if (s) out.push(s);
  }
  return out;
}

/** Which requirement slots could this single course advance, for this student? */
export function fulfillmentFor(
  section: Section,
  sets: RequirementSet[],
): { setId: string; setName: string; kind: string; groupId: string; groupName: string }[] {
  const out: ReturnType<typeof fulfillmentFor> = [];
  for (const set of sets) {
    for (const g of set.groups) {
      if (groupMatches(g, section)) {
        out.push({
          setId: set.id,
          setName: set.name,
          kind: set.kind,
          groupId: g.id,
          groupName: g.name,
        });
      }
    }
  }
  return out;
}

/* ========================================================================= */
/* Progress: bipartite matching of planned courses -> requirement slots       */
/* ========================================================================= */

type Slot = { groupIndex: number; creditDriven: boolean };

/** Kuhn's maximum bipartite matching. Returns slotIndex -> sectionId. */
function maxMatch(slots: Slot[], adjacency: number[][]): Map<number, number> {
  const slotOwner = new Map<number, number>(); // slot -> section idx
  const tryAugment = (si: number, seen: Set<number>): boolean => {
    for (const slot of adjacency[si]) {
      if (seen.has(slot)) continue;
      seen.add(slot);
      const incumbent = slotOwner.get(slot);
      if (incumbent === undefined || tryAugment(incumbent, seen)) {
        slotOwner.set(slot, si);
        return true;
      }
    }
    return false;
  };
  // Sections with fewer options first tends to find a good matching quickly.
  const order = adjacency
    .map((a, i) => [a.length, i] as const)
    .sort((x, y) => x[0] - y[0])
    .map(([, i]) => i);
  for (const si of order) tryAugment(si, new Set());
  return slotOwner;
}

/**
 * Credit rules: at most 5C schools, a 0.5-credit course does NOT satisfy a
 * GE requirement (nor a Breadth-of-Knowledge box) — a full credit is needed
 * — while its credits still count toward the 32-credit graduation total.
 */
export function halfCredit(s: Section): boolean {
  return s.credits_5c < 1;
}

/** Breadth-of-Knowledge style groups — identified by name across all sets. */
export function isBreadthGroup(g: RequirementGroup): boolean {
  return /breadth/i.test(g.name);
}

/** Educational Objectives / Breadth groups may take the same course twice. */
export function isDoubleDipGroup(g: RequirementGroup): boolean {
  return /educational objective|breadth/i.test(g.name);
}

/** A half-credit course is barred from this group's boxes. */
function halfBlocked(set: RequirementSet, g: RequirementGroup): boolean {
  return set.kind === "ge" || isBreadthGroup(g);
}

export function progressForSet(
  set: RequirementSet,
  planned: Section[],
  opts: {
    /** groupIndex -> planned[] indices the student/advisor checked into that
     *  group's box. Checked sections count even when no rule matches them.
     *  The same planned[] index may be checked in several groups. */
    pinned?: Map<number, number[]>;
  } = {},
): SetProgress {
  const pinned = opts.pinned ?? new Map<number, number[]>();

  // Half-credit bar: which groups may not be filled by 0.5-credit courses.
  const blocked = set.groups.map((g) => halfBlocked(set, g));
  const half = planned.map(halfCredit);

  // Eligible pins consume course slots; a blocked half-credit pin still
  // displays (transparency) but earns no box here.
  const countedPinned = set.groups.map((_, gi) =>
    (pinned.get(gi) ?? []).filter((i) => !(blocked[gi] && half[i])),
  );
  const pinnedByGroup = countedPinned.map((l) => l.length);
  const pinnedIdx = new Set<number>();
  for (const list of pinned.values()) for (const i of list) pinnedIdx.add(i);

  // slots per group: one per required course. Credit-driven groups get one
  // slot and are then topped up greedily. Locked sections consume slots
  // first, so only the remaining (open) slots go to the matcher.
  const slots: Slot[] = [];
  const slotGroup: number[] = [];
  set.groups.forEach((g, gi) => {
    const creditDriven = !g.min_courses && !!g.min_credits;
    const count = creditDriven ? 1 : Math.max(1, g.min_courses ?? 1);
    const open = Math.max(0, count - pinnedByGroup[gi]);
    for (let k = 0; k < open; k++) {
      slots.push({ groupIndex: gi, creditDriven });
      slotGroup.push(gi);
    }
  });

  // Free sections: not checked into a box above.
  const freeIdx: number[] = [];
  for (let i = 0; i < planned.length; i++) {
    if (pinnedIdx.has(i)) continue;
    freeIdx.push(i);
  }

  const adjacency = freeIdx.map((pi) => {
    const s = planned[pi];
    const hits: number[] = [];
    slots.forEach((slot, slotIdx) => {
      if (blocked[slot.groupIndex] && half[pi]) return; // 0.5 cr can't tick GE/breadth
      if (groupMatches(set.groups[slot.groupIndex], s)) hits.push(slotIdx);
    });
    return hits;
  });

  const slotOwner = maxMatch(slots, adjacency);

  // Checked boxes first (only the ones that actually count), then the matcher.
  const assignedPerGroup: number[][] = countedPinned.map((l) => [...l]);
  for (const [slotIdx, freePos] of slotOwner) {
    assignedPerGroup[slotGroup[slotIdx]].push(freeIdx[freePos]);
  }

  const used = new Set<number>(pinnedIdx);
  for (const list of assignedPerGroup) for (const i of list) used.add(i);

  // Credit-driven top-up: keep adding unmatched matching courses until the
  // credit floor is met.
  set.groups.forEach((g, gi) => {
    if (g.min_courses || !g.min_credits) return;
    let have = assignedPerGroup[gi].reduce((sum, si) => sum + planned[si].credits_5c, 0);
    for (const si of freeIdx) {
      if (used.has(si)) continue;
      if (blocked[gi] && half[si]) continue; // 0.5 cr can't tick GE/breadth
      if (have >= g.min_credits) break;
      if (groupMatches(g, planned[si])) {
        assignedPerGroup[gi].push(si);
        used.add(si);
        have += planned[si].credits_5c;
      }
    }
  });

  // Double-dip pass: Educational-Objective / Breadth groups may ALSO take a
  // course another group in this set already used. Each course's credits are
  // still counted only once in the set total (see `used` below).
  set.groups.forEach((g, gi) => {
    if (!isDoubleDipGroup(g)) return;
    for (let i = 0; i < planned.length; i++) {
      if (assignedPerGroup[gi].includes(i)) continue;
      if (blocked[gi] && half[i]) continue;
      if (!used.has(i)) continue;
      if (groupMatches(g, planned[i])) assignedPerGroup[gi].push(i);
    }
  });

  const groups: GroupProgress[] = set.groups.map((g, gi) => {
    const matchedIdx = assignedPerGroup[gi];
    const matched = matchedIdx.map((i) => planned[i]);
    const pinnedList = (pinned.get(gi) ?? []).map((i) => planned[i]);
    const haveCredits = matched.reduce((s, x) => s + x.credits_5c, 0);
    const haveCourses = matched.length;
    const neededCourses = g.min_courses ?? 0;
    const neededCredits = g.min_credits ?? null;

    const courseOk = neededCourses ? haveCourses >= neededCourses : true;
    const creditOk = neededCredits ? haveCredits >= neededCredits : true;
    const satisfied = g.required === 0 ? true : courseOk && creditOk && (courseOk || creditOk);

    const excess = planned.filter(
      (s, i) =>
        !matchedIdx.includes(i) && !(blocked[gi] && half[i]) && groupMatches(g, s),
    );

    return {
      group: g,
      matched,
      pinned: pinnedList,
      neededCourses,
      neededCredits,
      haveCourses,
      haveCredits: Number(haveCredits.toFixed(2)),
      satisfied,
      partial: !satisfied && haveCourses > 0,
      excess,
    };
  });

  const required = groups.filter((g) => g.group.required !== 0);
  const satisfiedGroups = required.filter((g) => g.satisfied).length;
  return {
    set,
    groups,
    satisfiedGroups,
    totalGroups: required.length,
    percent: required.length ? Math.round((satisfiedGroups / required.length) * 100) : 100,
    // Normalized 5C credits, so HMC's 3-credit scale can't inflate a total
    // being compared against a floor written in 1.0-per-course terms.
    creditsPlanned: Number(
      [...used].reduce((a, i) => a + (planned[i]?.credits_5c ?? 0), 0).toFixed(2),
    ),
    creditsRequired: set.total_credits ?? null,
  };
}

/**
 * A manual counting decision: "this course ticks this requirement box" — an
 * advisor designation, an open-ended group ("Data-science designated courses"),
 * or study-abroad / transfer credit. One row per (course, box), so a course
 * can be checked off in several boxes at once: across sets (GE + major +
 * minor may all take the same class) and, for Educational-Objective / Breadth
 * groups, more than once inside a set.
 */
export type Assignment = {
  /** section id or manual_course id — whichever course is being counted. */
  courseId: string;
  courseKind: "section" | "manual";
  setId: string;
  groupId: string;
  note: string | null;
};

type AssignmentRow = {
  course_id: string;
  course_kind: "section" | "manual";
  set_id: string;
  group_id: string;
  note: string | null;
};

/** All of a student's checked boxes, grouped by course. */
export function assignmentsFor(userId: string): {
  sections: Map<string, Assignment[]>;
  manuals: Map<string, Assignment[]>;
} {
  const rows = all<AssignmentRow>(
    `SELECT COALESCE(section_id, manual_id) AS course_id,
            CASE WHEN section_id IS NOT NULL THEN 'section' ELSE 'manual' END AS course_kind,
            set_id, group_id, note
     FROM requirement_assignments
     WHERE user_id = ?
     ORDER BY group_id`,
    [userId],
  );
  const out: { sections: Map<string, Assignment[]>; manuals: Map<string, Assignment[]> } = {
    sections: new Map(),
    manuals: new Map(),
  };
  for (const r of rows) {
    const a: Assignment = {
      courseId: r.course_id,
      courseKind: r.course_kind,
      setId: r.set_id,
      groupId: r.group_id,
      note: r.note,
    };
    const map = r.course_kind === "manual" ? out.manuals : out.sections;
    const list = map.get(r.course_id) ?? [];
    list.push(a);
    map.set(r.course_id, list);
  }
  return out;
}

/**
 * Replace the full set of checked boxes for one course. `groupIds` is the
 * list of boxes the student checked (empty = back to automatic). Every box is
 * validated first so a stale id can't wedge a course out of all counting.
 */
export function setCourseAssignments(
  userId: string,
  courseId: string,
  courseKind: "section" | "manual",
  groupIds: string[],
  note: string | null = null,
): { ok: true; count: number } | { ok: false; error: string } {
  if (courseKind === "section") {
    if (!get<{ id: string }>("SELECT id FROM sections WHERE id = ?", [courseId]))
      return { ok: false, error: "That section is not in the synced catalog." };
  } else if (!getManualCourse(courseId, userId)) {
    return { ok: false, error: "That manual course is not yours." };
  }

  const col = courseKind === "section" ? "section_id" : "manual_id";
  const groups: { id: string; set_id: string }[] = [];
  for (const gid of [...new Set(groupIds.map((g) => g.trim()).filter(Boolean))]) {
    const g = get<{ id: string; set_id: string }>(
      "SELECT id, set_id FROM requirement_groups WHERE id = ?",
      [gid],
    );
    if (!g) return { ok: false, error: "Unknown requirement box — reload the page and try again." };
    groups.push(g);
  }

  tx(() => {
    run(`DELETE FROM requirement_assignments WHERE user_id = ? AND ${col} = ?`, [
      userId,
      courseId,
    ]);
    for (const g of groups) {
      run(
        `INSERT INTO requirement_assignments(id, user_id, ${col}, set_id, group_id, note, created_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(user_id, ${col}, group_id) DO UPDATE SET
           note = excluded.note,
           created_at = excluded.created_at`,
        [newId("asn-"), userId, courseId, g.set_id, g.id, note, nowIso()],
      );
    }
  });
  return { ok: true, count: groups.length };
}

/* ========================================================================= */
/* Manual courses: study abroad, transfer credit, create-your-own            */
/* ========================================================================= */

const MANUAL_DEPT: Record<ManualCourseKind, string> = {
  abroad: "ABROAD",
  transfer: "XFER",
  custom: "CUSTOM",
};

/** The student's manually-entered courses. */
export function manualCoursesFor(userId: string): ManualCourse[] {
  const rows = all<ManualCourse>(
    "SELECT * FROM manual_courses WHERE user_id = ? ORDER BY created_at ASC",
    [userId],
  );
  return rows.map((r) => ({ ...r }));
}

export function getManualCourse(id: string, userId?: string): ManualCourse | undefined {
  const row = userId
    ? get<ManualCourse>("SELECT * FROM manual_courses WHERE id = ? AND user_id = ?", [id, userId])
    : get<ManualCourse>("SELECT * FROM manual_courses WHERE id = ?", [id]);
  return row ? { ...row } : undefined;
}

/**
 * A manual course as a pseudo-Section so the engine, the full-plan list and
 * the timetable's "no scheduled meeting" row can treat it like any other
 * course. It has no meetings, instructors or catalog areas — the checked
 * boxes in requirement_assignments are what make it count.
 */
export function manualPseudoSection(m: ManualCourse, school: SchoolCode): Section {
  return {
    id: m.id,
    term_id: m.term_id ?? "",
    department: MANUAL_DEPT[m.kind] ?? "CUSTOM",
    course_number: 0,
    suffix: "",
    affiliation: "",
    section_number: 0,
    half: null,
    code_string: `${MANUAL_DEPT[m.kind] ?? "CUSTOM"} · ${m.title}`,
    course_code: "",
    title: m.title,
    description: m.note ?? "",
    school,
    credits: m.credits,
    perm_count: 0,
    seats_total: 0,
    seats_filled: 0,
    status: "O",
    start_date: null,
    end_date: null,
    potential_error: 0,
    school_short: schoolShort(school),
    credits_5c: m.credits,
    meetings: [],
    instructors: [],
    areas: [],
    manual: { termLabel: m.term_label, kind: m.kind },
  };
}

export type ManualCourseInput = {
  term_id: string | null;
  term_label: string;
  title: string;
  credits: number;
  kind: ManualCourseKind;
  note: string | null;
};

export function addManualCourse(
  userId: string,
  input: ManualCourseInput,
): { ok: true; id: string } | { ok: false; error: string } {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give the course a title first." };
  const credits = Number(input.credits);
  if (!Number.isFinite(credits) || credits <= 0 || credits > 12)
    return { ok: false, error: "Credits must be between 0.25 and 12 (5C-normalized)." };
  if (input.term_id && !get<{ id: string }>("SELECT id FROM terms WHERE id = ?", [input.term_id]))
    return { ok: false, error: "Unknown term — pick one of the synced terms." };
  if (!input.term_id && !input.term_label.trim())
    return { ok: false, error: "Pick a term." };
  const id = newId("man-");
  run(
    `INSERT INTO manual_courses(id, user_id, term_id, term_label, title, credits, kind, note, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      id,
      userId,
      input.term_id,
      input.term_id ? termLabelOf(input.term_id) : input.term_label.trim(),
      title,
      credits,
      input.kind,
      input.note,
      nowIso(),
    ],
  );
  return { ok: true, id };
}

export function removeManualCourse(userId: string, id: string): boolean {
  const res = run("DELETE FROM manual_courses WHERE id = ? AND user_id = ?", [id, userId]);
  return Number(res.changes) > 0;
}

/* ---------------------------- planner term flags ------------------------- */

/** Which of the student's terms are flagged "studying abroad". */
export function abroadFlagsFor(userId: string): Map<string, boolean> {
  const rows = all<{ term_id: string; is_abroad: number }>(
    "SELECT term_id, is_abroad FROM user_term_flags WHERE user_id = ?",
    [userId],
  );
  return new Map(rows.map((r) => [r.term_id, r.is_abroad === 1]));
}

export function setAbroadFlag(userId: string, termId: string, abroad: boolean): void {
  run(
    `INSERT INTO user_term_flags(user_id, term_id, is_abroad) VALUES(?,?,?)
     ON CONFLICT(user_id, term_id) DO UPDATE SET is_abroad = excluded.is_abroad`,
    [userId, termId, abroad ? 1 : 0],
  );
}

/** Display label for a group id, e.g. "CMC General Education — Arts". */
export function groupLabel(groupId: string): string | undefined {
  const row = get<{ gname: string; sname: string }>(
    `SELECT g.name AS gname, s.name AS sname
     FROM requirement_groups g JOIN requirement_sets s ON s.id = g.set_id
     WHERE g.id = ?`,
    [groupId],
  );
  return row ? `${row.sname} — ${row.gname}` : undefined;
}

/** Drop assignments pointing at sets the profile no longer tracks. */
export function pruneAssignments(userId: string, keepSetIds: string[]): number {
  if (keepSetIds.length === 0) {
    const res = run("DELETE FROM requirement_assignments WHERE user_id = ?", [userId]);
    return Number(res.changes);
  }
  const res = run(
    `DELETE FROM requirement_assignments
     WHERE user_id = ? AND set_id NOT IN (${keepSetIds.map(() => "?").join(",")})`,
    [userId, ...keepSetIds],
  );
  return Number(res.changes);
}

export function progressForUser(
  user: UserPrograms & { id?: string | null },
  planned: Section[],
  opts: {
    assignments?: { sections: Map<string, Assignment[]>; manuals: Map<string, Assignment[]> };
  } = {},
): SetProgress[] {
  const assignments =
    opts.assignments ??
    (user.id
      ? assignmentsFor(user.id)
      : { sections: new Map<string, Assignment[]>(), manuals: new Map<string, Assignment[]>() });
  const sets = setsForUser(user);
  const idxById = new Map<string, number>();
  planned.forEach((s, i) => {
    if (!idxById.has(s.id)) idxById.set(s.id, i);
  });

  return sets.map((set) => {
    // Checked boxes pin the course into that group. The same course may be
    // checked in several sets (GE + major + minor now share courses) and in
    // several groups of one set; the engine resolves intra-set double-dips
    // for Educational-Objective / Breadth groups in progressForSet.
    const pinned = new Map<number, number[]>();
    for (const list of [...assignments.sections.values(), ...assignments.manuals.values()]) {
      for (const a of list) {
        if (a.setId !== set.id) continue;
        const si = idxById.get(a.courseId);
        if (si === undefined) continue; // not in this plan slice
        const gi = set.groups.findIndex((g) => g.id === a.groupId);
        if (gi === -1) continue; // stale group id — ignore
        const cur = pinned.get(gi) ?? [];
        if (!cur.includes(si)) cur.push(si);
        pinned.set(gi, cur);
      }
    }
    return progressForSet(set, planned, { pinned });
  });
}

/** Groups a section could have filled but didn't because a slot was contested. */
export function contestedGroupsFor(
  sectionId: string,
  progresses: SetProgress[],
): { setName: string; groupName: string }[] {
  const out: { setName: string; groupName: string }[] = [];
  for (const p of progresses) {
    for (const g of p.groups) {
      if (g.satisfied) continue;
      const sec = [...g.excess].find((s) => s.id === sectionId);
      if (sec) out.push({ setName: p.set.name, groupName: g.group.name });
    }
  }
  return out;
}
