#!/usr/bin/env node
/**
 * check-sets-po.mjs — validator for data/requirements/majors-po.json (Pomona College).
 *
 * Read-only: opens data/db.sqlite with node:sqlite `readOnly` and only issues SELECTs.
 * It never writes to the DB and never runs the loader.
 *
 * Checks (per docs/MAJORS-BRIEF.md):
 *   1. JSON parses; ids unique + well formed (major-PO-* / minor-PO-*); school === "PO";
 *      kind major|minor; verified === false; source is an http(s) URL; every set has >=2
 *      groups; every group has >=1 positive rule and minCourses or minCredits; every
 *      referenced department exists in data/requirements/departments.json.
 *   2. every `courses` code resolves to a real section (DB pads numbers to 3 digits) —
 *      reports the hit rate and lists codes that can never match.
 *   3. match smoke test against 400 random PO sections using a copy of the matcher
 *      semantics in lib/requirements.ts. Sets matching 0 sections are flagged.
 *
 * Usage: node scripts/check-sets-po.mjs [path/to/file.json]
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "data/requirements/majors-po.json");
const DB = path.join(ROOT, "data/db.sqlite");
const CODE = "PO";
const SAMPLE = Number(process.env.SAMPLE || 400);

const errors = [];
const notes = [];
const fail = (m) => {
  errors.push(m);
  console.log("  X " + m);
};

const DEPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/requirements/departments.json"), "utf8"));
const UNIVERSE = new Set(Object.values(DEPTS).flatMap((v) => Object.keys(v)));

/* ------------------------- matcher (copy of lib) ------------------------- */
const norm = (c) => String(c).toUpperCase().replace(/\s+/g, " ").trim();

/** Mirrors codeEquals() in lib/requirements.ts. */
function codeEquals(sectionCourseCode, wanted) {
  const a = norm(sectionCourseCode);
  const b = norm(wanted);
  if (a === b) return true;
  const m = /^(.*?)\s+(\d+[A-Z]*)\s+([A-Z]{2})$/.exec(a);
  const parts = b.split(" ");
  if (parts.length === 2 && m && norm(parts[0]) === a.split(" ")[0] && norm(parts[1]) === m[2])
    return true;
  if (b.endsWith("*") && a.startsWith(norm(b.slice(0, -1)))) return true;
  return false;
}

function matchSection(m, s) {
  switch (m.type) {
    case "area":
      return (s.areas ?? []).some((code) =>
        m.codes.some((w) =>
          w.endsWith("*") ? norm(code).startsWith(norm(w.slice(0, -1))) : norm(code) === norm(w),
        ),
      );
    case "course":
      return m.codes.some((c) => codeEquals(s.course_code, c));
    case "department": {
      if (norm(s.department) !== norm(m.department)) return false;
      if (typeof m.min === "number" && s.course_number < m.min) return false;
      if (typeof m.max === "number" && s.course_number > m.max) return false;
      if (m.schools?.length && !m.schools.includes(s.school)) return false;
      return true;
    }
    case "any":
      return m.schools?.length ? m.schools.includes(s.school) : true;
    case "titleKeyword": {
      const hay = `${s.title ?? ""} ${s.description ?? ""}`.toLowerCase();
      return m.keywords.some((k) => String(k).toLowerCase().length && hay.includes(String(k).toLowerCase()));
    }
    case "and":
      return (m.children ?? []).every((c) => matchSection(c, s));
    case "or":
      return (m.children ?? []).some((c) => matchSection(c, s));
    case "not":
      return !matchSection(m.child, s);
    default:
      return false;
  }
}

/** Mirrors compileRules() in lib/requirements.ts (group sugar -> OR of positives, AND NOT exclude). */
function compileRules(g) {
  const positives = [];
  if (g.area?.length) positives.push({ type: "area", codes: g.area });
  if (g.courses?.length) positives.push({ type: "course", codes: g.courses });
  for (const d of g.departments ?? []) positives.push({ type: "department", ...d });
  if (g.titleKeywords?.length) positives.push({ type: "titleKeyword", keywords: g.titleKeywords });
  if (g.any) positives.push({ type: "any" });
  for (const m of g.matchers ?? []) positives.push(m);
  const neg = [];
  if (g.exclude?.area?.length) neg.push({ type: "area", codes: g.exclude.area });
  if (g.exclude?.courses?.length) neg.push({ type: "course", codes: g.exclude.courses });
  for (const d of g.exclude?.departments ?? []) neg.push({ type: "department", ...d });
  const rules = neg.length
    ? positives.map((p) => ({ type: "and", children: [p, { type: "not", child: { type: "or", children: neg } }] }))
    : positives;
  return { positives, rules };
}

/* ------------------------------ course codes ----------------------------- */
function collectCodes(group, out) {
  for (const c of group.courses ?? []) out.add(c);
  for (const c of group.exclude?.courses ?? []) out.add(c);
  const walk = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.type === "course" && Array.isArray(m.codes)) m.codes.forEach((c) => out.add(c));
    (m.children ?? []).forEach(walk);
    if (m.child) walk(m.child);
  };
  (group.matchers ?? []).forEach(walk);
}

/* ------------------------ code resolvability (real lib) ------------------ */
/**
 * lib/requirements.ts codeEquals() matches ONLY
 *   - an exact, zero-padded, affiliation-bearing sections.course_code, or
 *   - a trailing-`*` prefix of one.
 * A bare two-part code ("HIST 101") never matches anything, so it is a dead rule.
 */
function codeIsLive(code, allCodes) {
  const b = norm(code);
  if (b.endsWith("*")) return allCodes.some((a) => a.startsWith(b.slice(0, -1)));
  if (b.split(" ").length !== 3) return false; // two-part form is dead in the engine
  const m = /^([A-Z]+) (\d{3}[A-Z]*) [A-Z]{2}$/.exec(b);
  if (!m) return false;
  return allCodes.includes(b);
}

/* --------------------------------- main ---------------------------------- */
console.log(`check-sets-po: ${path.relative(ROOT, FILE)}`);

let doc;
try {
  doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  console.error("FATAL: JSON.parse failed: " + e.message);
  process.exit(1);
}

if (!Array.isArray(doc.sets) || !doc.sets.length) fail("file has no sets[]");
if (!doc._comment) fail("missing top-level _comment provenance note");

const db = new DatabaseSync(DB, { readOnly: true });
const existsStmt = db.prepare("SELECT COUNT(*) AS n FROM sections WHERE course_code = ?");
const affStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM sections WHERE department=? AND course_number=? AND suffix=?",
);

const allCodes = new Set();
for (const set of doc.sets ?? []) for (const g of set.groups ?? []) collectCodes(g, allCodes);

const dbCodes = db.prepare("SELECT DISTINCT course_code FROM sections").all().map((r) => norm(r.course_code));

const resolved = [];
const unresolved = [];
for (const code of [...allCodes].sort()) {
  if (codeIsLive(code, dbCodes)) resolved.push(code);
  else unresolved.push(code);
}
const deadTwoPart = unresolved.filter((c) => /^\S+ \d+[A-Z]*$/.test(norm(c)));
const hitRate = allCodes.size ? (resolved.length / allCodes.size) * 100 : 100;

const corpus = db
  .prepare(
    `SELECT s.id, s.course_code, s.department, s.course_number, s.school, s.title, s.description,
            COALESCE((SELECT json_group_array(a.area_code) FROM section_areas a WHERE a.section_id = s.id), '[]') AS aj
       FROM sections s WHERE s.school = ?`,
  )
  .all(CODE)
  .map((r) => ({ ...r, areas: JSON.parse(r.aj).filter(Boolean) }));
// Pomona students cross-register across the 5Cs, so a group whose only real
// sections are taught at CM/HM/PZ/SC is still satisfiable. Group liveness is
// therefore tested against the whole 5C catalog; set liveness keeps using PO.
const all5c = db
  .prepare(
    `SELECT s.id, s.course_code, s.department, s.course_number, s.school, s.title, s.description,
            COALESCE((SELECT json_group_array(a.area_code) FROM section_areas a WHERE a.section_id = s.id), '[]') AS aj
       FROM sections s`,
  )
  .all()
  .map((r) => ({ ...r, areas: JSON.parse(r.aj).filter(Boolean) }));
const sections = [...corpus].sort(() => Math.random() - 0.5).slice(0, SAMPLE);
console.log(`corpus: ${corpus.length} ${CODE} sections | smoke sample: ${sections.length}`);

const ids = new Set();
const rows = [];
for (const set of doc.sets ?? []) {
  const tag = set.id ?? "(missing id)";
  if (ids.has(set.id)) fail(`${tag}: duplicate id`);
  ids.add(set.id);
  if (!new RegExp(`^(major|minor)-${CODE}-[A-Z0-9]+$`).test(set.id ?? ""))
    fail(`${tag}: id does not match (major|minor)-${CODE}-SLUG`);
  if (set.school !== CODE) fail(`${tag}: school=${set.school}, must be ${CODE}`);
  if (!["major", "minor"].includes(set.kind)) fail(`${tag}: kind must be major|minor (${set.kind})`);
  if (!set.name) fail(`${tag}: missing name`);
  if (set.verified !== false) fail(`${tag}: verified must be false`);
  if (!/^https?:\/\/.+/.test(set.source ?? "")) fail(`${tag}: source must be an exact scraped URL`);
  if (!/^https:\/\/catalog\.pomona\.edu\//.test(set.source ?? ""))
    notes.push(`${tag}: source is not a catalog.pomona.edu URL (${set.source})`);
  if (!Array.isArray(set.groups) || set.groups.length < 2)
    fail(`${tag}: needs >=2 groups (has ${set.groups?.length ?? 0})`);

  const zeroGroups = [];
  let hits = 0;
  for (const s of sections)
    if ((set.groups ?? []).some((g) => compileRules(g).rules.some((r) => matchSection(r, s)))) hits++;
  let poHits = 0;
  for (const s of corpus)
    if ((set.groups ?? []).some((g) => compileRules(g).rules.some((r) => matchSection(r, s)))) poHits++;

  for (const g of set.groups ?? []) {
    const { positives, rules } = compileRules(g);
    if (!positives.length) fail(`${tag} / "${g.name}": no positive rule`);
    if (g.minCourses == null && g.minCredits == null)
      fail(`${tag} / "${g.name}": needs minCourses or minCredits`);
    if (!g.name || !g.notes) fail(`${tag}: a group is missing name/notes provenance`);
    for (const d of g.departments ?? [])
      if (!UNIVERSE.has(d.department)) fail(`${tag} / "${g.name}": dept ${d.department} not in departments.json`);
    let anyHits = 0;
    for (const s of all5c) if (rules.some((r) => matchSection(r, s))) anyHits++;
    if (!anyHits) zeroGroups.push(g.name);
  }
  const setZero =
    !hits &&
    !corpus.some((s) => (set.groups ?? []).some((g) => compileRules(g).rules.some((r) => matchSection(r, s))));
  if (!poHits) fail(`${tag}: matches 0 of ${corpus.length} ${CODE} sections (dead set)`);
  rows.push({ id: set.id, kind: set.kind, groups: set.groups?.length ?? 0, hits, poHits,
              zeroGroups: zeroGroups.join("; ") });
}

console.log(`\nper set (PO-corpus hits / ${corpus.length}; 400-sample hits / ${sections.length}):`);
for (const r of rows.sort((a, b) => a.poHits - b.poHits || a.id.localeCompare(b.id)))
  console.log(
    `  ${String(r.kind).padEnd(5)} ${String(r.groups).padStart(2)}g  corpus ${String(r.poHits).padStart(4)}  sample ${String(r.hits).padStart(3)}  ${r.id}` +
      (r.zeroGroups ? `   [dead group: ${r.zeroGroups}]` : ""),
  );

const zeroHits = rows.filter((r) => !r.poHits);
console.log(
  `\ncourse-code resolution: ${resolved.length}/${allCodes.size} (${hitRate.toFixed(1)}%)`,
);
if (unresolved.length) {
  console.log("unresolved (can never match a synced section):");
  for (const u of unresolved) console.log("  - " + u);
}
console.log(`sets: ${rows.length} (${rows.filter((r) => r.kind === "major").length} major / ${rows.filter((r) => r.kind === "minor").length} minor)`);
console.log(`sets with 0 sampled hits: ${zeroHits.length}${zeroHits.length ? " -> " + zeroHits.map((r) => r.id).join(", ") : ""}`);
console.log(`median corpus hits: ${(() => { const h = rows.map((r) => r.poHits).sort((a, b) => a - b); return h[Math.floor(h.length / 2)]; })()}`);
console.log(`sets with a dead group: ${rows.filter((r) => r.zeroGroups).length}`);
for (const n of notes) console.log("  ! " + n);
console.log(`\nerrors: ${errors.length}`);
console.log(errors.length ? "FAIL" : "PASS");
process.exit(errors.length ? 1 : 0);
