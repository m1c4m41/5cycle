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
import { cache } from "react";
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
import { applySequenceOverrides } from "./sequences";
import {
  boxSection,
  pairKey,
  overlapPolicyFor,
  validateCounting,
  type CountingSet,
} from "./counting";

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

export async function loadRequirementFiles(dir = REQ_DIR): Promise<{ sets: number; groups: number }> {
  if (!fs.existsSync(dir)) return { sets: 0, groups: 0 };
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((x, y) => fileRank(x) - fileRank(y) || x.localeCompare(y));

  let sets = 0;
  let groups = 0;

  await tx(async () => {
    for (const file of files) {
      let parsed: FileSpec;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as FileSpec;
      } catch (err) {
        throw new Error(`Bad JSON in data/requirements/${file}: ${(err as Error).message}`);
      }
      for (const spec of parsed.sets ?? []) {
        await run(
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
        await run("DELETE FROM requirement_groups WHERE set_id = ?", [spec.id]);

        for (const [i, g] of (spec.groups ?? []).entries()) {
          const gid = `${spec.id}::${g.id ?? slug(g.name) ?? i}`;
          await run(
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
            await run("INSERT INTO requirement_rules(group_id, match) VALUES(?,?)", [
              gid,
              JSON.stringify(m),
            ]);
          }
        }
      }
    }
    await run(
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

export async function requirementsLoaded(): Promise<boolean> {
  return Number((await get<{ n: number }>("SELECT COUNT(*) n FROM requirement_sets"))?.n ?? 0) > 0;
}

/* ========================================================================= */
/* Reading definitions                                                       */
/* ========================================================================= */

export async function getSet(setId: string): Promise<RequirementSet | undefined> {
  const set = await get<Omit<RequirementSet, "groups">>("SELECT * FROM requirement_sets WHERE id = ?", [
    setId,
  ]);
  if (!set) return undefined;
  return { ...set, groups: await getGroups(setId) };
}

type GroupRow = Omit<RequirementGroup, "rules"> & { rule_json: string | null };

const GROUPS_SELECT = `SELECT g.*, (
    SELECT json_group_array(r.match) FROM requirement_rules r WHERE r.group_id = g.id
  ) AS rule_json
  FROM requirement_groups g`;

function parseGroupRow(g: GroupRow): RequirementGroup {
  const { rule_json, ...rest } = g;
  let raw: (string | null)[] = [];
  try {
    raw = rule_json ? (JSON.parse(rule_json) as (string | null)[]) : [];
  } catch {
    raw = [];
  }
  return applySequenceOverrides({
    ...rest,
    rules: raw
      .filter(Boolean)
      .map((json, i) => ({ id: i, match: JSON.parse(json as string) as Matcher })),
  });
}

function worthEntry(g: RequirementGroup, s: Section) {
  return (g.worth ?? []).find((e) => e.codes.some((c) => codeEquals(s.course_code, c)));
}

/** How many courses of this group's requirement one course counts as (1 normally). */
function courseWorth(g: RequirementGroup, s: Section): number {
  return worthEntry(g, s)?.counts ?? 1;
}

async function getGroups(setId: string): Promise<RequirementGroup[]> {
  const rows = await all<GroupRow>(`${GROUPS_SELECT} WHERE g.set_id = ? ORDER BY g.position ASC`, [
    setId,
  ]);
  return rows.map(parseGroupRow);
}

/** Loads groups + rules for many sets in a SINGLE query (avoids N+1 over HTTP). */
async function getGroupsForSets(setIds: string[]): Promise<Map<string, RequirementGroup[]>> {
  const bySet = new Map<string, RequirementGroup[]>();
  for (const id of setIds) bySet.set(id, []);
  if (setIds.length === 0) return bySet;
  const rows = await all<GroupRow>(
    `${GROUPS_SELECT} WHERE g.set_id IN (${setIds.map(() => "?").join(", ")}) ORDER BY g.set_id ASC, g.position ASC`,
    setIds,
  );
  for (const r of rows) {
    bySet.get(r.set_id)?.push(parseGroupRow(r));
  }
  return bySet;
}

export async function listSets(filter: { school?: string; kind?: string } = {}): Promise<RequirementSet[]> {
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
  const rows = await all<Omit<RequirementSet, "groups">>(
    `SELECT * FROM requirement_sets ${clause} ORDER BY kind ASC, name ASC`,
    params,
  );
  return attachGroups(rows);
}

async function attachGroups(rows: Omit<RequirementSet, "groups">[]): Promise<RequirementSet[]> {
  const bySet = await getGroupsForSets(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, groups: bySet.get(r.id) ?? [] }));
}

export type UserPrograms = {
  school: string;
  major_id: string | null;
  /** Double major — tracked with the same engine as the first major. */
  major2_id?: string | null;
  minor_id: string | null;
};

// cache() keys on argument identity, so memoize on the primitive program ids
// (not the user object): any caller with the same programs shares one read.
const setsForPrograms = cache(
  async (school: string, major: string, major2: string, minor: string): Promise<RequirementSet[]> => {
    const ids = [`ge-${school}`, major, major2, minor].filter(Boolean);
    const ph = ids.map(() => "?").join(",");
    const rows = await all<Omit<RequirementSet, "groups">>(
      `SELECT * FROM requirement_sets WHERE id IN (${ph})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return attachGroups(ids.map((id) => byId.get(id)).filter(Boolean) as Omit<RequirementSet, "groups">[]);
  },
);

export function setsForUser(u: UserPrograms): Promise<RequirementSet[]> {
  return setsForPrograms(u.school, u.major_id ?? "", u.major2_id ?? "", u.minor_id ?? "");
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

/* ------------------------------------------------------------------ */
/* Lab requirement detection                                           */
/* ------------------------------------------------------------------ */

/** "lab", "labs", "laboratory", "laboratories" as whole words — not
 *  "syllabus" (no word boundary before the "lab") and not "labor". */
const LAB_WORD_RE = /\b(lab|labs|laboratory|laboratories)\b/i;
/** Explicit non-lab phrasing, e.g. "Four non-laboratory chemistry courses". */
const NON_LAB_RE = /\b(non|without|no)[\s-]*(lab|laborator)/i;

/**
 * The group's own name declares a laboratory requirement — "Foundation
 * laboratories", "One laboratory course (PSYC…)", "Natural Sciences (with
 * laboratory)", "PHYS 106L… Laboratory course". Name-based so it works for
 * every program at all five campuses without per-major hard-coding; the
 * satisfaction math is the same matcher the checklist already uses.
 */
export function isLabGroup(g: RequirementGroup): boolean {
  const name = g.name ?? "";
  return LAB_WORD_RE.test(name) && !NON_LAB_RE.test(name);
}

/** Lab phrasing that appears only in a group's prose note, e.g.
 *  "…including at least three laboratory courses" or "three must carry a lab". */
const LAB_NOTE_RE =
  /laborator|carry(ing)?\s+(a|an|one|two|three|four|five|six)\s+lab\b|\bwith\s+lab\b/i;

/**
 * The group is not itself a lab box, but its note says part of it must be
 * laboratory courses ("six biology electives … including at least three
 * laboratory courses"). The rule matches the whole group, so how many of the
 * counted courses actually carry a lab cannot be separated automatically —
 * the tracker surfaces these as advisor-check items with the note.
 * Returns the note text, or null.
 */
export function labProseNote(g: RequirementGroup): string | null {
  const note = g.notes ?? "";
  if (!note || isLabGroup(g)) return null;
  if (NON_LAB_RE.test(note)) return null;
  return LAB_NOTE_RE.test(note) ? note : null;
}

/* ------------------------------------------------------------------ */
/* Lab / upper-division course detection                               */
/* ------------------------------------------------------------------ */

/** Lab word in a course title: "… Laboratory", "… w/Lab", "Lab, Intro to…". */
const TITLE_LAB_RE = /\b(labs?|laborator\w*)\b/i;
/** Title words that look lab-ish but are not (CM "Policy Lab"). */
const TITLE_NOT_LAB_RE = /\bpolicy\s+lab\b/i;
/** A course code with an L subscript typed into the title, e.g. a manually
 *  entered "NEUR 148L – Cell and Molecular Neuroscience". */
const TITLE_CODE_L_RE = /\b\d{1,4}L\b/;

/** School token from the course code ("BIOL 148L KS" → "KS"); falls back to
 *  the section's school column. */
function schoolTokenOf(s: Section): string {
  const m = /\s([A-Z]{2})$/.exec(s.course_code ?? "");
  return m ? m[1] : s.school;
}

/**
 * Does this section count as a laboratory course? Verified against the
 * catalog of all five campuses:
 *  - "LX" subscript — the *separated* lab half of a lecture/lab pair
 *    (Keck "BIOL 043L" + "BIOL 043LX"): always a lab;
 *  - "L" subscript: a lab when the course has NO "LX" sibling — the lab is
 *    integrated ("Vertebrate Physiology w/Lab", "Human Anatomy With Lab",
 *    NEUR 148L) — but NOT when a separate "LX" section exists anywhere in
 *    the catalog, because then the "L" is the lecture;
 *  - Pomona's trailing-L lab components (CHEM 001AL/001BL, CSCI 051PL …);
 *  - a lab word in the title (HMC: "Physical Chemistry Laboratory";
 *    Pomona: "Intro to Statistics w/Lab").
 *  HMC / CMC / Keck use two-letter AL / BL / LA / LB codes for plain section
 *  variants and parts, so those count only when the title agrees.
 */
export function isLabCourse(s: Section, lxKeys?: Set<string>): boolean {
  const title = s.title ?? "";
  if (NON_LAB_RE.test(title)) return false;
  const suffix = (s.suffix ?? "").toUpperCase();
  if (suffix === "LX") return true;
  if (suffix === "L") {
    if (lxKeys?.has(`${s.school}|${s.department}|${s.course_number}`)) return false;
    return true;
  }
  if (suffix.length === 2 && suffix.endsWith("L") && schoolTokenOf(s) === "PO") return true;
  if (TITLE_NOT_LAB_RE.test(title)) return false;
  return TITLE_LAB_RE.test(title) || TITLE_CODE_L_RE.test(title);
}

/**
 * Keys (`school|department|course_number`) of courses that have a separate
 * "LX" lab section *anywhere* in the synced catalog. The lecture/lab split
 * is a property of the course, not the term — Keck's BIOL 043L/043LX pair
 * appears in different terms across the year — so the lookup is global.
 * `isLabCourse` uses this to stop counting the "L" lecture when the lab
 * lives in the "LX" section.
 */
export async function labLxKeys(): Promise<Set<string>> {
  const rows = await all<{ k: string }>(
    `SELECT DISTINCT school || '|' || department || '|' || course_number AS k
     FROM sections WHERE suffix = 'LX'`,
  );
  return new Set(rows.map((r) => r.k));
}

/** Numbered at/above `min` (upper division is 100+ at all five campuses). */
export function isUpperCourse(s: Section, min = 100): boolean {
  return typeof s.course_number === "number" && s.course_number >= min;
}

/* ------------------------------------------------------------------ */
/* Prose condition parsing (lab counts + division floors)              */
/* ------------------------------------------------------------------ */

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
function toNum(t: string): number | null {
  const k = t.trim().toLowerCase();
  if (k in NUM_WORDS) return NUM_WORDS[k];
  const n = parseInt(k, 10);
  return Number.isFinite(n) ? n : null;
}

/** Ordered most-specific first: "at least three laboratory courses",
 *  "three must carry a lab", "two of the remainder must still include a
 *  laboratory", "three of which must be laboratory", "(one with lab)", and a
 *  loose "N of which … laboratory" fallback. */
const LAB_NUM_PATTERNS: RegExp[] = [
  /(?:at least|no fewer than|at minimum)\s+(one|two|three|four|five|six|seven|\d+)\s+(?:more\s+)?(?:additional\s+)?(?:laborator\w*|labs?)\b/i,
  /\b(one|two|three|four|five|six|\d+)\s+(?:courses?\s+)?(?:must|should)\s+(?:carry\s+(?:a|an)\s+)?(?:laborator\w*|labs?)\b/i,
  /\b(one|two|three|four|five|six|\d+)\s+of\s+the\s+(?:remainder|remaining)\s+must\s+still\s+include\s+a\s+laboratory/i,
  /(?:at least\s+)?(one|two|three|four|five|six|\d+)\s+of\s+(?:which|them|these)\s+(?:must|should)\s+(?:be\s+|carry\s+)?(?:an?\s+)?(?:laborator\w*|labs?)\b/i,
  /(?:at least|no fewer than|at minimum)\s+(one|two|three|four|five|six|\d+)\s+with\s+(?:a\s+)?(?:laborator\w*|labs?)\b/i,
  /\((?:at least\s+)?(one|two|three|four|five|six|\d+)\s+(?:labs?|with lab)\)/i,
  /(?:at least\s+)?(one|two|three|four|five|six|\d+)\s+of\s+(?:which|them|these|the\s+\w+)\s+[^.;]{0,40}?(?:laborator\w*|labs?\b)/i,
];

/** The "at least N laboratory courses" figure a group's prose states — null
 *  when the note mentions labs without a number. */
export function labNeedFromProse(g: RequirementGroup): number | null {
  const text = `${g.notes ?? ""} ${g.name ?? ""}`;
  for (const re of LAB_NUM_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const n = toNum(m[1]);
      if (n != null) return n;
    }
  }
  return null;
}

/** Explicit course-number floors in the prose: "numbered 100 or higher",
 *  "numbered above 100", "at or above 100", "102 and above". */
function explicitFloors(text: string): number[] {
  const out: number[] = [];
  const re =
    /numbered\s+(?:at\s+or\s+above|above|at\s+least)?\s*(\d{1,3})\b|at\s+or\s+above\s*(\d{1,3})\b|(\d{1,3})\s+or\s+(?:higher|above)\b|(\d{1,3})\s+and\s+above\b/g;
  for (const m of text.matchAll(re)) out.push(parseInt(m[1] ?? m[2] ?? m[3] ?? m[4], 10));
  return out;
}

/** "N of M must be upper-division" / "at least one numbered 100 or above" /
 *  "the other should be upper-division" — how many of the group's courses
 *  the prose demands be upper-division. */
function upperNOfM(text: string): number | null {
  let m = text.match(
    /\b(one|two|three|four|five|six|\d+)\s+of\s+(?:the\s+)?(?:five|six|seven|eight|\d+)\s+must\s+(?:be\s+)?(?:an?\s+)?upper[- ]division/i,
  );
  if (m) return toNum(m[1]);
  m = text.match(
    /\bat least\s+(one|two|three|four|five|six|\d+)\s+(?:course|courses)?\s*numbered\s+(?:at\s+or\s+above|above|at\s+least)?\s*(\d{1,3})/i,
  );
  if (m) return toNum(m[1]);
  if (/\bthe\s+other\s+(?:should|must)\s+be\s+(?:an?\s+)?upper[- ]division/i.test(text)) return 1;
  return null;
}

/** Upper-division phrasing that is only an option, not a demand:
 *  "Lower- or upper-division elective", "an equivalent upper-division
 *  class", "may petition …", "a student who places out …". */
const UPPER_OPTION_RE =
  /\blower[-\s]*or\s+upper\b|\bmay\s+petition\b|\bplaces\s+out\b|\bequivalent\s+upper[- ]division\b/i;

function codeNumber(code: string): number | null {
  const m = String(code).match(/(\d{1,4})/);
  return m ? parseInt(m[1], 10) : null;
}

/** Does this matcher only admit courses numbered at/above `min`? Rules are
 *  OR alternatives at the group level, so a group enforces a floor only when
 *  every one of its rules does. */
function ruleEnforcesMin(m: Matcher, min: number): boolean {
  if (!m) return false;
  switch (m.type) {
    case "department":
      return typeof m.min === "number" && m.min >= min;
    case "course": {
      const ns = (m.codes ?? []).map(codeNumber).filter((n): n is number => n != null);
      return ns.length > 0 && ns.every((n) => n >= min);
    }
    case "and":
      return (m.children ?? []).some((ch) => ruleEnforcesMin(ch, min));
    case "or":
      return (m.children ?? []).length > 0 && (m.children ?? []).every((ch) => ruleEnforcesMin(ch, min));
    default:
      return false;
  }
}

/** Course codes the rules allow (excluding "not" subtrees — those codes are
 *  barred, not permitted). */
function collectAllowedCodes(m: Matcher, out: string[]): void {
  if (!m) return;
  switch (m.type) {
    case "course":
      out.push(...(m.codes ?? []));
      break;
    case "and":
    case "or":
      (m.children ?? []).forEach((ch) => collectAllowedCodes(ch, out));
      break;
    default:
      break;
  }
}

/**
 * The group's prose demands that its courses be upper-division, but the
 * checklist rule does not already enforce the floor — so the division part
 * is a sub-count the tracker can surface. Returns the demand
 * ({need: how many of the counted courses, minNum: the number floor}) or null
 * when there is no clean demand:
 *  - "upper-division" only as an option ("…or an equivalent upper-division
 *    class", "Lower- or upper-division elective") → null;
 *  - mixed floors in one note ("MATH 102+ or CSCI 070+") → null;
 *  - the rule already enforces the floor → null (the checklist forces it);
 *  - the rule lists specific courses below the floor (the list is the real
 *    demand, e.g. a program list containing HIST 055) → null.
 */
export function upperProseNeed(g: RequirementGroup): { need: number; minNum: number } | null {
  const text = `${g.notes ?? ""} ${g.name ?? ""}`;
  const upperWord = /\bupper[- ]division\b/i.test(text);
  const nOfM = upperNOfM(text);
  const rawFloors = explicitFloors(text);
  if (new Set(rawFloors).size >= 2) return null; // "102 or higher … 070 or higher"
  // A single explicit floor wins even when it sits below 100 (HMC calls
  // CSCI 070+ "upper-division"); otherwise "upper-division" implies 100+.
  const floor = rawFloors.length === 1 ? rawFloors[0] : null;
  const minNum = floor ?? (upperWord ? 100 : null);
  if (minNum == null) return null;
  if (nOfM == null && !upperWord && floor == null) return null;
  if (UPPER_OPTION_RE.test(text)) return null;
  const need = nOfM ?? g.min_courses;
  if (!need) return null;
  if (g.rules.length > 0 && g.rules.every((r) => ruleEnforcesMin(r.match, minNum))) return null;
  const codes: string[] = [];
  g.rules.forEach((r) => collectAllowedCodes(r.match, codes));
  if (codes.some((c) => { const n = codeNumber(c); return n != null && n < minNum; })) return null;
  return { need, minNum };
}

export type LabItem = {
  set: RequirementSet;
  gp: GroupProgress;
  /** "group": the requirement itself is a lab box.
   *  "note": a lab is part of a larger requirement — the prose says how many.
   *  "upper": the prose demands upper-division (numbered at/above `minNum`)
   *    courses but the checklist rule does not enforce the floor. */
  tier: "group" | "note" | "upper";
  /** The courses that count for this group (matched + checked-box pins). */
  counted: Section[];
  /** How many of `counted` carry a lab indicator (L subscript / lab title). */
  labCount: number;
  /** Prose's "at least N laboratory courses" — null when unnumbered. */
  labNeed: number | null;
  /** Prose's division demand: at least this many of `counted` numbered
   *  at/above `minNum`. Null when the rule already enforces it. */
  upperNeed: number | null;
  /** The division floor the prose asks for (100 by default). */
  minNum: number;
  upperCount: number;
};

/** The courses that count for a group: the matcher's picks plus any the
 *  student/advisor pinned in by checked box. */
function countSources(gp: GroupProgress): Section[] {
  const out: Section[] = [...gp.matched];
  for (const s of gp.pinned) if (!out.some((x) => x.id === s.id)) out.push(s);
  return out;
}

/** Lab / division-related items across a list of set progresses
 *  (GE, majors, minors). Pass `labLxKeys()` so an "L" lecture whose lab
 *  lives in a separate "LX" section isn't double-counted. */
export function labItemsFor(progresses: SetProgress[], lxKeys?: Set<string>): LabItem[] {
  const out: LabItem[] = [];
  for (const p of progresses) {
    for (const gp of p.groups) {
      const g = gp.group;
      const counted = countSources(gp);
      const up = upperProseNeed(g);
      const minNum = up ? up.minNum : 100;
      const base = {
        set: p.set,
        gp,
        counted,
        labCount: counted.filter((s) => isLabCourse(s, lxKeys)).length,
        upperCount: counted.filter((s) => isUpperCourse(s, minNum)).length,
        minNum,
      };
      if (isLabGroup(g)) {
        out.push({ ...base, tier: "group", labNeed: null, upperNeed: null });
      } else if (labProseNote(g)) {
        out.push({
          ...base,
          tier: "note",
          labNeed: labNeedFromProse(g),
          upperNeed: up ? up.need : null,
        });
      } else if (up) {
        out.push({ ...base, tier: "upper", labNeed: null, upperNeed: up.need });
      }
    }
  }
  return out;
}

export type LabSummary = {
  /** Lab classes done toward the numbered lab requirements (capped per box). */
  have: number;
  /** Lab classes the program's numbered lab requirements add up to. */
  need: number;
  /** need − have: how many more lab classes to take. */
  remaining: number;
  /** Lab-related groups whose prose gives no number (not in have/need). */
  unnumbered: number;
};

/**
 * One lab counter for a program: every lab box counts its course floor, and
 * every "at least N laboratory courses" note counts N. `have` is capped per
 * box so a surplus in one box can't hide a shortfall in another.
 */
/** A group named after one specific course ("PSYC143 PO - Social Cognitive … with
 *  Lab") — a catalog list item, not a count of labs. */
const NAMED_COURSE_GROUP_RE = /^[A-Z]{2,5}\s?\d{2,3}[A-Z]{0,2}\s+[A-Z]{2}\b/;

export function labSummary(items: LabItem[]): LabSummary {
  let have = 0;
  let need = 0;
  let unnumbered = 0;
  let named: LabItem[] = [];
  for (const it of items) {
    const g = it.gp.group;
    if (it.tier === "group") {
      if (NAMED_COURSE_GROUP_RE.test(g.name)) {
        named.push(it);
        continue;
      }
      const prose = labNeedFromProse(g); // "three of which must be laboratory"
      const n = prose ?? g.min_courses ?? 1;
      need += n;
      have +=
        prose != null
          ? Math.min(it.labCount, n)
          : g.min_courses
            ? Math.min(it.gp.haveCourses, n)
            : it.gp.satisfied
              ? 1
              : 0;
    } else if (it.tier === "note") {
      if (it.labNeed != null) {
        need += it.labNeed;
        have += Math.min(it.labCount, it.labNeed);
      } else unnumbered++;
    }
  }
  // Named lab courses are individual requirements only when the program gives
  // no lab count of its own; otherwise they are the options for that count.
  if (need === 0) {
    for (const it of named) {
      need += 1;
      have += it.gp.haveCourses > 0 ? 1 : 0;
    }
  }
  return { have, need, remaining: Math.max(0, need - have), unnumbered };
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
  // Pinned courses fill as many slots as they are worth (accelerated course = 2).
  const pinnedByGroup = countedPinned.map((l, gi) =>
    l.reduce((n, i) => n + courseWorth(set.groups[gi], planned[i]), 0),
  );
  const pinnedIdx = new Set<number>();
  for (const list of pinned.values()) for (const i of list) pinnedIdx.add(i);

  // Two-for-one courses (accelerated standing in for a sequence) fill several
  // slots of their group at once; set them aside before the matcher runs.
  const worthFill: number[][] = set.groups.map(() => []);
  const worthSlots: number[] = set.groups.map(() => 0);
  set.groups.forEach((g, gi) => {
    if (!g.worth?.length || (!g.min_courses && g.min_credits)) return;
    const need = Math.max(1, g.min_courses ?? 1);
    for (let i = 0; i < planned.length; i++) {
      if (worthSlots[gi] + pinnedByGroup[gi] >= need) break;
      if (pinnedIdx.has(i) || worthFill.some((l) => l.includes(i))) continue;
      if (blocked[gi] && half[i]) continue;
      const w = courseWorth(g, planned[i]);
      if (w > 1 && groupMatches(g, planned[i])) {
        worthFill[gi].push(i);
        worthSlots[gi] += w;
      }
    }
  });
  const worthIdx = new Set<number>(worthFill.flat());
  // Once a two-for-one course stands in for its sequence, the courses it
  // replaces (014L/015L for 029L…) no longer count separately in that group.
  const replacedIdx: Set<number>[] = set.groups.map((g, gi) => {
    const out = new Set<number>();
    for (const wi of worthFill[gi]) {
      const rep = worthEntry(g, planned[wi])?.replaces ?? [];
      planned.forEach((s, i) => {
        if (i !== wi && rep.some((c) => codeEquals(s.course_code, c))) out.add(i);
      });
    }
    return out;
  });

  // slots per group: one per required course. Credit-driven groups get one
  // slot and are then topped up greedily. Locked sections consume slots
  // first, so only the remaining (open) slots go to the matcher.
  const slots: Slot[] = [];
  const slotGroup: number[] = [];
  set.groups.forEach((g, gi) => {
    const creditDriven = !g.min_courses && !!g.min_credits;
    const count = creditDriven ? 1 : Math.max(1, g.min_courses ?? 1);
    const open = Math.max(0, count - pinnedByGroup[gi] - worthSlots[gi]);
    for (let k = 0; k < open; k++) {
      slots.push({ groupIndex: gi, creditDriven });
      slotGroup.push(gi);
    }
  });

  // Free sections: not checked into a box above.
  const freeIdx: number[] = [];
  for (let i = 0; i < planned.length; i++) {
    if (pinnedIdx.has(i) || worthIdx.has(i)) continue;
    freeIdx.push(i);
  }

  const adjacency = freeIdx.map((pi) => {
    const s = planned[pi];
    const hits: number[] = [];
    slots.forEach((slot, slotIdx) => {
      if (blocked[slot.groupIndex] && half[pi]) return; // 0.5 cr can't tick GE/breadth
      if (replacedIdx[slot.groupIndex].has(pi)) return; // covered by the two-for-one course
      if (groupMatches(set.groups[slot.groupIndex], s)) hits.push(slotIdx);
    });
    return hits;
  });

  const slotOwner = maxMatch(slots, adjacency);

  // Checked boxes first (only the ones that actually count), then the matcher.
  const assignedPerGroup: number[][] = countedPinned.map((l, gi) => [...l, ...worthFill[gi]]);
  for (const [slotIdx, freePos] of slotOwner) {
    assignedPerGroup[slotGroup[slotIdx]].push(freeIdx[freePos]);
  }

  const used = new Set<number>([...pinnedIdx, ...worthIdx]);
  for (const list of assignedPerGroup) for (const i of list) used.add(i);

  // Credit-driven top-up: keep adding unmatched matching courses until the
  // credit floor is met.
  set.groups.forEach((g, gi) => {
    if (g.min_courses || !g.min_credits) return;
    let have = assignedPerGroup[gi].reduce((sum, si) => sum + planned[si].credits_5c, 0);
    for (const si of freeIdx) {
      if (used.has(si)) continue;
      if (blocked[gi] && half[si]) continue; // 0.5 cr can't tick GE/breadth
      if (replacedIdx[gi].has(si)) continue;
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
    // A two-for-one course counts as the several courses it stands in for.
    const haveCourses = matched.reduce((n, s) => n + courseWorth(g, s), 0);
    const neededCourses = g.min_courses ?? 0;
    const neededCredits = g.min_credits ?? null;

    const courseOk = neededCourses ? haveCourses >= neededCourses : true;
    const creditOk = neededCredits ? haveCredits >= neededCredits : true;
    const satisfied = g.required === 0 ? true : courseOk && creditOk && (courseOk || creditOk);

    const excess = planned.filter(
      (s, i) =>
        !matchedIdx.includes(i) &&
        !replacedIdx[gi].has(i) &&
        !(blocked[gi] && half[i]) &&
        groupMatches(g, s),
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
export async function assignmentsFor(userId: string): Promise<{
  sections: Map<string, Assignment[]>;
  manuals: Map<string, Assignment[]>;
}> {
  const rows = await all<AssignmentRow>(
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

/** What the counting form needs to know about one course against the student's sets. */
export function countingSetsFor(sets: RequirementSet[], course: Section): CountingSet[] {
  return sets.map((set) => ({
    id: set.id,
    name: set.name,
    kind: set.kind,
    groups: set.groups.map((g) => ({
      id: g.id,
      name: g.name,
      section: boxSection(g.name),
      matches: groupMatches(g, course),
      // A major/minor group that lists this exact course counts it on its own.
      auto: set.kind !== "ge" && g.rules.some((r) => namesCourse(r.match, course)),
    })),
  }));
}

/** Does this matcher list the course by code ("CSCI 081"), as opposed to a
 *  broad rule (department band, area, keyword, "any")? */
function namesCourse(m: Matcher, s: Section): boolean {
  if (m.type === "course") return matchSection(m, s);
  if (m.type === "or") return m.children.some((c) => namesCourse(c, s));
  return false;
}

/** Counting sets with no rule matches — for a course that doesn't exist yet. */
export function blankCountingSets(sets: RequirementSet[]): CountingSet[] {
  return sets.map((set) => ({
    id: set.id,
    name: set.name,
    kind: set.kind,
    groups: set.groups.map((g) => ({ id: g.id, name: g.name, section: boxSection(g.name), matches: false })),
  }));
}

/**
 * How many courses OTHER than `excludeCourseId` already share each pair of the
 * student's sets (GE↔program included — the campus policy decides which pairs
 * are capped). A course belongs to a set when the student checked one of its
 * boxes OR the set lists the course by code (auto-counted). `courses` is the
 * student's planned courses, needed to find the auto-counted memberships.
 */
export function pairUseFrom(
  assignments: { sections: Map<string, Assignment[]>; manuals: Map<string, Assignment[]> },
  sets: RequirementSet[],
  excludeCourseId: string,
  courses: Section[] = [],
): Record<string, number> {
  const members = new Map<string, Set<string>>(); // courseId -> set ids
  const add = (courseId: string, setId: string) => {
    if (!members.has(courseId)) members.set(courseId, new Set());
    members.get(courseId)!.add(setId);
  };
  for (const map of [assignments.sections, assignments.manuals])
    for (const [courseId, list] of map) for (const a of list) add(courseId, a.setId);
  for (const c of courses)
    for (const set of sets)
      if (set.kind !== "ge" && set.groups.some((g) => g.rules.some((r) => namesCourse(r.match, c))))
        add(c.id, set.id);

  const uses: Record<string, number> = {};
  for (const [courseId, setIds] of members) {
    if (courseId === excludeCourseId) continue;
    const ids = [...setIds];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const k = pairKey(ids[i], ids[j]);
        uses[k] = (uses[k] ?? 0) + 1;
      }
  }
  return uses;
}

/**
 * Replace the full set of checked boxes for one course. `groupIds` is the
 * list of boxes the student checked (empty = back to automatic). Every box is
 * validated first so a stale id can't wedge a course out of all counting.
 */
export async function setCourseAssignments(
  userId: string,
  courseId: string,
  courseKind: "section" | "manual",
  groupIds: string[],
  note: string | null = null,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  if (courseKind === "section") {
    if (!(await get<{ id: string }>("SELECT id FROM sections WHERE id = ?", [courseId])))
      return { ok: false, error: "That section is not in the synced catalog." };
  } else if (!(await getManualCourse(courseId, userId))) {
    return { ok: false, error: "That manual course is not yours." };
  }

  const col = courseKind === "section" ? "section_id" : "manual_id";
  const groups: { id: string; set_id: string }[] = [];
  for (const gid of [...new Set(groupIds.map((g) => g.trim()).filter(Boolean))]) {
    const g = await get<{ id: string; set_id: string }>(
      "SELECT id, set_id FROM requirement_groups WHERE id = ?",
      [gid],
    );
    if (!g) return { ok: false, error: "Unknown requirement box — reload the page and try again." };
    groups.push(g);
  }

  // Enforce the counting rules server-side too (the form greys boxes out, but
  // never trust the client): GE boxes must match, one Educational-Objective /
  // Breadth box per section, one shared course per program pair.
  if (groups.length > 0) {
    const u = await get<UserPrograms & { id: string }>(
      "SELECT id, school, major_id, major2_id, minor_id FROM users WHERE id = ?",
      [userId],
    );
    if (u) {
      const sets = await setsForUser(u);
      const course =
        courseKind === "section"
          ? await (await import("./catalog")).getSection(courseId)
          : manualPseudoSection((await getManualCourse(courseId, userId))!, u.school as SchoolCode);
      if (course) {
        const verdict = validateCounting({
          sets: countingSetsFor(sets, course),
          strictGe: courseKind === "section",
          checkedIds: groups.map((g) => g.id),
          policy: overlapPolicyFor(u.school),
          pairUse: pairUseFrom(
            await assignmentsFor(userId),
            sets,
            courseId,
            await (await import("./schedule")).enrolledSections(userId),
          ),
        });
        if (!verdict.ok) return verdict;
      }
    }
  }

  await tx(async () => {
    await run(`DELETE FROM requirement_assignments WHERE user_id = ? AND ${col} = ?`, [
      userId,
      courseId,
    ]);
    for (const g of groups) {
      await run(
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
  planned: "PLAN",
  summer: "SUMMER",
};

/** The student's manually-entered courses. */
export async function manualCoursesFor(userId: string): Promise<ManualCourse[]> {
  const rows = await all<ManualCourse>(
    "SELECT * FROM manual_courses WHERE user_id = ? ORDER BY created_at ASC",
    [userId],
  );
  return rows.map((r) => ({ ...r }));
}

export async function getManualCourse(id: string, userId?: string): Promise<ManualCourse | undefined> {
  const row = userId
    ? await get<ManualCourse>("SELECT * FROM manual_courses WHERE id = ? AND user_id = ?", [id, userId])
    : await get<ManualCourse>("SELECT * FROM manual_courses WHERE id = ?", [id]);
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

export async function addManualCourse(
  userId: string,
  input: ManualCourseInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give the course a title first." };
  const credits = Number(input.credits);
  if (!Number.isFinite(credits) || credits <= 0 || credits > 12)
    return { ok: false, error: "Credits must be between 0.25 and 12 (5C-normalized)." };
  // Any real term id is fine, published yet or not (summers, future terms).
  if (input.term_id && !/^(FA|SP|SU)\d{4}$/.test(input.term_id))
    return { ok: false, error: "Unknown term — pick a term from the list." };
  if (!input.term_id && !input.term_label.trim())
    return { ok: false, error: "Pick a term." };
  const id = newId("man-");
  await run(
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

export async function removeManualCourse(userId: string, id: string): Promise<boolean> {
  const res = await run("DELETE FROM manual_courses WHERE id = ? AND user_id = ?", [id, userId]);
  return Number(res.changes) > 0;
}

/* ---------------------------- planner term flags ------------------------- */

/** Which of the student's terms are flagged "studying abroad". */
export async function abroadFlagsFor(userId: string): Promise<Map<string, boolean>> {
  const [rows, legacy] = await Promise.all([
    all<{ term_id: string }>("SELECT term_id FROM study_abroad_terms WHERE user_id = ?", [userId]),
    all<{ term_id: string; is_abroad: number }>(
      "SELECT term_id, is_abroad FROM user_term_flags WHERE user_id = ? AND is_abroad = 1",
      [userId],
    ),
  ]);
  return new Map([...legacy.map((r) => r.term_id), ...rows.map((r) => r.term_id)].map((t) => [t, true]));
}

/** Study-abroad term ids, chronological. */
export async function abroadTermsFor(userId: string): Promise<string[]> {
  const m = await abroadFlagsFor(userId);
  const key = (id: string) => {
    const x = /^(FA|SP|SU)(\d{4})$/.exec(id);
    return x ? Number(x[2]) * 10 + (x[1] === "SP" ? 1 : x[1] === "SU" ? 2 : 3) : 0;
  };
  return [...m.keys()].sort((a, b) => key(a) - key(b));
}

export async function setAbroadFlag(userId: string, termId: string, abroad: boolean): Promise<void> {
  if (!/^(FA|SP|SU)\d{4}$/.test(termId)) return;
  if (abroad) {
    await run("INSERT OR IGNORE INTO study_abroad_terms(user_id, term_id) VALUES(?,?)", [userId, termId]);
  } else {
    await run("DELETE FROM study_abroad_terms WHERE user_id = ? AND term_id = ?", [userId, termId]);
    await run("DELETE FROM user_term_flags WHERE user_id = ? AND term_id = ?", [userId, termId]);
  }
}

/** Display label for a group id, e.g. "CMC General Education — Arts". */
export async function groupLabel(groupId: string): Promise<string | undefined> {
  const row = await get<{ gname: string; sname: string }>(
    `SELECT g.name AS gname, s.name AS sname
     FROM requirement_groups g JOIN requirement_sets s ON s.id = g.set_id
     WHERE g.id = ?`,
    [groupId],
  );
  return row ? `${row.sname} — ${row.gname}` : undefined;
}

/** Drop assignments pointing at sets the profile no longer tracks. */
export async function pruneAssignments(userId: string, keepSetIds: string[]): Promise<number> {
  if (keepSetIds.length === 0) {
    const res = await run("DELETE FROM requirement_assignments WHERE user_id = ?", [userId]);
    return Number(res.changes);
  }
  const res = await run(
    `DELETE FROM requirement_assignments
     WHERE user_id = ? AND set_id NOT IN (${keepSetIds.map(() => "?").join(",")})`,
    [userId, ...keepSetIds],
  );
  return Number(res.changes);
}

export async function progressForUser(
  user: UserPrograms & { id?: string | null },
  planned: Section[],
  opts: {
    assignments?: { sections: Map<string, Assignment[]>; manuals: Map<string, Assignment[]> };
  } = {},
): Promise<SetProgress[]> {
  const assignments =
    opts.assignments ??
    (user.id
      ? await assignmentsFor(user.id)
      : { sections: new Map<string, Assignment[]>(), manuals: new Map<string, Assignment[]>() });
  const sets = await setsForUser(user);
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
