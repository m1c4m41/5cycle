#!/usr/bin/env node
/**
 * check-sets-scr.mjs — validator for data/requirements/majors-scr.json (Scripps College, SC).
 *
 * Read-only: opens data/db.sqlite with node:sqlite { readOnly: true }. It never writes
 * to SQLite and never imports the app's loaders.
 *
 * Checks (per docs/MAJORS-BRIEF.md "Validation you must run"):
 *   1. JSON parses; ids unique; school is a valid campus code; kind is major|minor;
 *      every set has >=2 groups; every group has >=1 positive rule AND minCourses|minCredits.
 *   2. Every `courses` code resolves to >=1 row in sections.course_code -> report hit %.
 *   3. Match smoke test over 400 random SC sections + a 5C-wide distinct-course-code sweep;
 *      flag any set matching 0 sections and any group matching 0 sections 5C-wide.
 *   4. Per-set group counts and summary.
 *
 * Usage: node scripts/check-sets-scr.mjs [--smoke N]
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const FILE = path.join(ROOT, "data", "requirements", "majors-scr.json");
const DB = path.join(ROOT, "data", "requirements", "..", "db.sqlite");
const SCHOOL = "SC";
const VALID_SCHOOLS = ["PO", "CM", "HM", "PZ", "SC", "CG"];
const smokeArg = process.argv.indexOf("--smoke");
const SMOKE_N = smokeArg >= 0 ? Number(process.argv[smokeArg + 1]) : 400;

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);

/* ------------------------------------------------------------------ */
/* 1. structure                                                        */
/* ------------------------------------------------------------------ */
if (!fs.existsSync(FILE)) {
  console.error(`FATAL: missing ${FILE}`);
  process.exit(1);
}
let doc;
try {
  doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (err) {
  console.error(`FATAL: Bad JSON in data/requirements/majors-scr.json: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(doc._comment) || !doc._comment.length)
  fail("_comment must be a non-empty array of provenance strings");
if (!Array.isArray(doc.sets) || !doc.sets.length) fail("sets must be a non-empty array");

const sets = doc.sets ?? [];
const seen = new Set();
for (const s of sets) {
  if (!s.id) fail(`set without id: ${s.name}`);
  if (seen.has(s.id)) fail(`duplicate id ${s.id}`);
  seen.add(s.id);
  if (!VALID_SCHOOLS.includes(s.school)) fail(`${s.id}: bad school ${s.school}`);
  if (s.school !== SCHOOL) warnings.push(`${s.id}: school ${s.school} != ${SCHOOL}`);
  const prefix = s.id.split("-")[0];
  if (!["major", "minor"].includes(s.kind)) fail(`${s.id}: bad kind ${s.kind}`);
  if (prefix !== s.kind) fail(`${s.id}: id prefix ${prefix} != kind ${s.kind}`);
  if (s.kind === "major" && !/^major-SC-/.test(s.id)) fail(`${s.id}: major id must be major-SC-*`);
  if (s.kind === "minor" && !/^minor-SC-/.test(s.id)) fail(`${s.id}: minor id must be minor-SC-*`);
  if (s.verified !== false) fail(`${s.id}: verified must be false`);
  if (!/^https:\/\/catalog\.scrippscollege\.edu\//.test(s.source ?? ""))
    fail(`${s.id}: source must be an exact catalog.scrippscollege.edu URL (got ${s.source})`);
  if (!s.name) fail(`${s.id}: missing name`);
  if (!Array.isArray(s.groups) || s.groups.length < 2) fail(`${s.id}: needs >=2 groups`);
  for (const [i, g] of (s.groups ?? []).entries()) {
    const where = `${s.id}/g${i}(${g.name})`;
    const positives =
      (g.area?.length ?? 0) +
      (g.courses?.length ?? 0) +
      (g.departments?.length ?? 0) +
      (g.titleKeywords?.length ?? 0) +
      (g.matchers?.length ?? 0) +
      (g.any ? 1 : 0);
    if (!positives) fail(`${where}: no positive rule`);
    if (typeof g.minCourses !== "number" && typeof g.minCredits !== "number")
      fail(`${where}: needs minCourses or minCredits`);
    if (typeof g.minCourses === "number" && g.minCourses <= 0) fail(`${where}: minCourses <= 0`);
    for (const d of g.departments ?? []) {
      if (!/^[A-Z]{2,5}$/.test(d.department)) fail(`${where}: bad department ${d.department}`);
      if (d.schools) for (const sc of d.schools)
        if (!VALID_SCHOOLS.includes(sc)) fail(`${where}: bad schools filter ${sc}`);
    }
    for (const m of g.matchers ?? []) if (!m.type) fail(`${where}: matcher missing type`);
    if (g.level && !["intro", "upper", "any"].includes(g.level))
      fail(`${where}: bad level ${g.level}`);
  }
}

/* ------------------------------------------------------------------ */
/* matcher semantics (mirrors lib/requirements.ts)                     */
/* ------------------------------------------------------------------ */
const norm = (c) => String(c).toUpperCase().replace(/\s+/g, " ").trim();
function codeEquals(sectionCourseCode, wanted) {
  const a = norm(sectionCourseCode);
  const b = norm(wanted);
  if (a === b) return true;
  const [, numA] = /^(.*?)\s+(\d+[A-Z]*)\s+([A-Z]{2})$/.exec(a) ?? [];
  const parts = b.split(" ");
  if (parts.length === 2 && numA) {
    if (norm(parts[0]) === a.split(" ")[0] && norm(parts[1]) === numA) return true;
  }
  if (b.endsWith("*") && a.startsWith(norm(b.slice(0, -1)))) return true;
  return false;
}
function match(m, s) {
  switch (m.type) {
    case "course":
      return m.codes.some((c) => codeEquals(s.course_code, c));
    case "department":
      if (norm(s.department) !== norm(m.department)) return false;
      if (typeof m.min === "number" && s.course_number < m.min) return false;
      if (typeof m.max === "number" && s.course_number > m.max) return false;
      if (m.schools?.length && !m.schools.includes(s.school)) return false;
      return true;
    case "area":
      return (s.areas ?? []).some((a) =>
        m.codes.map(norm).some((c) => c === norm(a.code) || (c.endsWith("*") && norm(a.code).startsWith(c.slice(0, -1)))),
      );
    case "titleKeyword": {
      const hay = `${s.title} ${s.description ?? ""}`.toLowerCase();
      return m.keywords.some((k) => hay.includes(k.toLowerCase()));
    }
    case "any":
      return m.schools?.length ? m.schools.includes(s.school) : true;
    case "and":
      return m.children.every((c) => match(c, s));
    case "or":
      return m.children.some((c) => match(c, s));
    case "not":
      return !match(m.child, s);
    default:
      return false;
  }
}
const rulesOf = (g) => {
  const pos = [];
  if (g.area?.length) pos.push({ type: "area", codes: g.area });
  if (g.courses?.length) pos.push({ type: "course", codes: g.courses });
  for (const d of g.departments ?? [])
    pos.push({ type: "department", department: d.department, min: d.min, max: d.max, schools: d.schools });
  if (g.titleKeywords?.length) pos.push({ type: "titleKeyword", keywords: g.titleKeywords });
  if (g.any) pos.push({ type: "any" });
  for (const m of g.matchers ?? []) pos.push(m);
  const neg = [];
  if (g.exclude?.area?.length) neg.push({ type: "area", codes: g.exclude.area });
  if (g.exclude?.courses?.length) neg.push({ type: "course", codes: g.exclude.courses });
  for (const d of g.exclude?.departments ?? [])
    neg.push({ type: "department", department: d.department, min: d.min, max: d.max, schools: d.schools });
  if (!pos.length) pos.push({ type: "any" });
  return neg.length
    ? pos.map((p) => ({ type: "and", children: [p, ...neg.map((n) => ({ type: "not", child: n }))] }))
    : pos;
};

/* ------------------------------------------------------------------ */
/* 2. courses-code resolution + 3. smoke test                          */
/* ------------------------------------------------------------------ */
const db = new DatabaseSync(DB, { readOnly: true });
const exists = db.prepare("SELECT COUNT(*) AS n FROM sections WHERE course_code = ?");
const pad = (c) =>
  norm(c).replace(/(\d+)/, (m) => (m.length >= 3 ? m : m.padStart(3, "0")));

let codesTotal = 0;
let codesHit = 0;
const missingCodes = [];
// Resolution must use the *same* semantics the app uses (codeEquals above), because
// lib/requirements.ts only honours an exact "<DEPT> <NUM> <AFF>" match or a trailing-*
// prefix — a bare two-part "ECON 051" silently matches nothing in the real engine.
const allCodes = db.prepare("SELECT course_code FROM sections GROUP BY course_code").all().map((r) => r.course_code);
const resolves = (c) => allCodes.some((u) => codeEquals(u, c));
for (const s of sets)
  for (const g of s.groups ?? [])
    for (const c of g.courses ?? []) {
      codesTotal++;
      if (resolves(c)) codesHit++;
      else missingCodes.push(`${s.id}: ${c}`);
    }

// Deterministic pseudo-random sample: ORDER BY RANDOM() made the warning list flicker
// between runs (a different small set sampled 0 each time), so a validator run could not be
// reproduced or diffed. Rows are instead ordered by a stable FNV-1a hash of the section id,
// which is uniformly distributed but identical on every run.
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};
const sampleBy = (sql, ...args) =>
  db
    .prepare(sql)
    .all(...args)
    .sort((a, b) => fnv(String(a.id)) - fnv(String(b.id)))
    .slice(0, SMOKE_N)
    .map((r) => ({ ...r, areas: [] }));

const smoke = sampleBy(
  `SELECT id, course_code, department, course_number, school, title, description
     FROM sections WHERE school = ?`,
  SCHOOL,
);

// Scripps requirements are heavily cross-campus, so an SC-only sample under-reports
// coverage. Each set is therefore smoke-tested against SC sections PLUS a stable
// sample of the other 5C campuses' sections.
const offCampus = sampleBy(
  `SELECT id, course_code, department, course_number, school, title, description
     FROM sections WHERE school <> ?`,
  SCHOOL,
);

// 5C-wide sweep over distinct course codes (catches rules that can never match anywhere)
const universe = db
  .prepare(
    `SELECT course_code, department, course_number, school,
            MAX(title) AS title, MAX(description) AS description
       FROM sections GROUP BY course_code`,
  )
  .all()
  .map((r) => ({ ...r, areas: [] }));

const setHits = [];
for (const s of sets) {
  const sample = smoke.concat(offCampus);
  const rules = (s.groups ?? []).map((g) => ({ name: g.name, rs: rulesOf(g) }));
  const smokeGroups = new Set();
  let smokeSections = 0;
  for (const sec of sample) {
    let hit = false;
    rules.forEach((g, i) => {
      if (g.rs.some((r) => match(r, sec))) {
        smokeGroups.add(i);
        hit = true;
      }
    });
    if (hit) smokeSections++;
  }
  let wideCodes = new Set();
  const wideTotal = universe.filter((sec) =>
    rules.some((g) => g.rs.some((r) => match(r, sec))),
  ).length;
  const groupWide = rules.map((g, i) => {
    const hit = universe.filter((sec) => g.rs.some((r) => match(r, sec)));
    hit.forEach((h) => wideCodes.add(h.course_code));
    if (!hit.length) fail(`${s.id}/g${i}(${g.name}): matches 0 sections 5C-wide`);
    return hit.length;
  });
  if (!wideCodes.size) fail(`${s.id}: matches 0 sections 5C-wide (broken set)`);
  // A 0-sample result is only a *warning*: the smoke draw is a small random subsample, so a
  // genuinely tiny program (e.g. STS, 24 of 17694 sections) can miss the sample entirely by
  // luck. Liveness is decided by the 5C-wide sweep above, so quote that evidence here.
  if (!smokeSections)
    warnings.push(
      `${s.id}: 0 of ${sample.length} smoke sections match any group, but it matches ` +
        `${wideTotal} distinct 5C course codes (sampling noise, not a dead set)`,
    );
  setHits.push({
    id: s.id,
    groups: s.groups.length,
    deadGroups: groupWide.filter((n) => n === 0).length,
    minGroup: Math.min(...groupWide),
    wide: wideCodes.size,
    smokeGroups: smokeGroups.size,
    smokeSections,
    sample: sample.length,
  });
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */
console.log(`sets: ${sets.length}  majors: ${sets.filter((s) => s.kind === "major").length}  minors: ${sets.filter((s) => s.kind === "minor").length}`);
console.log(`groups: ${sets.reduce((a, s) => a + s.groups.length, 0)}`);
console.log(`courses matcher hit rate: ${codesHit}/${codesTotal} = ${(codesTotal ? (100 * codesHit) / codesTotal : 100).toFixed(1)}%`);
if (missingCodes.length) console.log(`unresolved courses codes:\n  ${missingCodes.join("\n  ")}`);
console.log(
  `smoke sample: ${smoke.length} SC + ${offCampus.length} off-campus sections; 5C universe: ${universe.length} distinct course codes`,
);
console.log(
  "\nid                        groups  smokeSectionsMatched  groupsMatchedInSmoke  weakestGroupCodes  distinctCodes5C",
);
for (const h of setHits)
  console.log(
    `${h.id.padEnd(26)}${String(h.groups).padStart(5)}${String(`${h.smokeSections}/${h.sample}`).padStart(22)}${String(h.smokeGroups).padStart(21)}${String(h.minGroup).padStart(19)}${String(h.wide).padStart(18)}`,
  );
if (warnings.length) console.log("\nwarnings:\n  " + warnings.join("\n  "));
if (errors.length) {
  console.log(`\nERRORS (${errors.length}):`);
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}
console.log("\nOK: all structural + matching checks passed");
