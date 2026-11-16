#!/usr/bin/env node
/**
 * check-sets-hm.mjs — validator for data/requirements/majors-hm.json (Harvey Mudd).
 *
 * Read-only: opens data/db.sqlite with node:sqlite readOnly and only issues SELECTs.
 * It never writes to the DB and never runs the loader.
 *
 * Checks (per docs/MAJORS-BRIEF.md):
 *   1. JSON parses; ids unique; school === "HM"; kind major|minor; verified === false;
 *      every set has >=2 groups; every group has >=1 positive rule and
 *      minCourses or minCredits.
 *   2. every `courses` code (including matchers/exclusions) resolves to a real
 *      section — reports the hit rate and lists codes that can never match.
 *   3. match smoke test against 400 random HM sections using a copy of the
 *      matcher semantics in lib/requirements.ts. Sets matching 0 sections are flagged.
 *
 * Usage: node scripts/check-sets-hm.mjs [path/to/file.json]
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "data/requirements/majors-hm.json");
const DB = path.join(ROOT, "data/db.sqlite");
const CODE = "HM";
const SAMPLE = 400;

const errors = [];
const notes = [];
const fail = (m) => {
  errors.push(m);
  console.log("  X " + m);
};

/* ------------------------- matcher (copy of lib) ------------------------- */
const norm = (c) => String(c).toUpperCase().replace(/\s+/g, " ").trim();

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

let areaRulesSeen = 0;

function matchSection(m, s) {
  switch (m.type) {
    case "area":
      // The synced `sections` table exposes no area codes, so area rules are
      // reported but not counted as matches here.
      areaRulesSeen++;
      return false;
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
/** "ENGR 85A HM" -> "ENGR 085A HM" (DB pads numbers to 3 digits). */
function padCode(code) {
  const m = /^([A-Z]+)\s+(\d+[A-Z]*)\s+([A-Z]{2})$/.exec(norm(code));
  if (!m) return null;
  const digits = m[2].replace(/[A-Z]+$/, "");
  const suffix = m[2].slice(digits.length);
  return digits.length >= 3 ? `${m[1]} ${m[2]} ${m[3]}` : `${m[1]} ${digits.padStart(3, "0")}${suffix} ${m[3]}`;
}

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

/* --------------------------------- main ---------------------------------- */
console.log(`check-sets-hm: ${path.relative(ROOT, FILE)}`);

let doc;
try {
  doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  console.error("FATAL: JSON.parse failed: " + e.message);
  process.exit(1);
}

if (!Array.isArray(doc.sets) || !doc.sets.length) fail("file has no sets[]");
if (!doc._comment) notes.push("no top-level _comment provenance note");

const db = new DatabaseSync(DB, { readOnly: true });
const existsStmt = db.prepare("SELECT COUNT(*) AS n FROM sections WHERE course_code = ?");

const allCodes = new Set();
for (const set of doc.sets ?? []) for (const g of set.groups ?? []) collectCodes(g, allCodes);

const resolved = [];
const unresolved = [];
for (const code of [...allCodes].sort()) {
  const cand = padCode(code);
  if (!cand) {
    fail(`unparseable course code: "${code}"`);
    unresolved.push(code);
    continue;
  }
  (existsStmt.get(cand).n > 0 ? resolved : unresolved).push(`${code} (as ${cand})`);
}
const hitRate = allCodes.size ? (resolved.length / allCodes.size) * 100 : 100;

/** Every ${CODE} section in the synced catalog — used for the strict pass. */
const corpus = db
  .prepare(
    `SELECT course_code, department, course_number, school, title, description
       FROM sections WHERE school = ?`,
  )
  .all(CODE);
/** The brief's smoke-test sample: 400 random ${CODE} sections. */
const sections = [...corpus]
  .sort(() => Math.random() - 0.5)
  .slice(0, SAMPLE);
console.log(`corpus: ${corpus.length} ${CODE} sections | smoke sample: ${sections.length}`);

const ids = new Set();
const rows = [];
for (const set of doc.sets ?? []) {
  const tag = set.id ?? "(missing id)";
  if (ids.has(set.id)) fail(`${tag}: duplicate id`);
  ids.add(set.id);
  if (set.school !== CODE) fail(`${tag}: school=${set.school}, must be ${CODE}`);
  if (!["major", "minor"].includes(set.kind)) fail(`${tag}: kind must be major|minor (${set.kind})`);
  if (!set.name) fail(`${tag}: missing name`);
  if (set.verified !== false) fail(`${tag}: verified must be false`);
  if (!/^https?:\/\/.+/.test(set.source ?? "")) fail(`${tag}: source must be an exact scraped URL`);
  if (!Array.isArray(set.groups) || set.groups.length < 2)
    fail(`${tag}: needs >=2 groups (has ${set.groups?.length ?? 0})`);

  const zeroGroups = [];
  // "hits" = sampled sections matching AT LEAST ONE group of the set (brief step 3).
  let hits = 0;
  for (const s of sections) {
    let any = false;
    for (const g of set.groups ?? []) {
      const { rules } = compileRules(g);
      if (rules.some((r) => matchSection(r, s))) {
        any = true;
        break;
      }
    }
    if (any) hits++;
  }
  for (const g of set.groups ?? []) {
    const { positives, rules } = compileRules(g);
    if (!positives.length) fail(`${tag} / "${g.name}": no positive rule`);
    if (g.minCourses == null && g.minCredits == null)
      fail(`${tag} / "${g.name}": needs minCourses or minCredits`);
    if (g.minCredits != null && !/(scale|HMC credit|5C|credits? per course)/i.test(g.notes ?? ""))
      notes.push(`${tag} / "${g.name}": minCredits without a scale note`);
    if (g.titleKeywords?.some((k) => String(k).trim().length < 4))
      notes.push(`${tag} / "${g.name}": very short titleKeyword in "${g.name}" may over-match`);
    // Strict pass over the whole HM corpus: a group that matches nothing at all is
    // only acceptable when it deliberately names off-campus courses.
    let corpusHits = 0;
    for (const s of corpus) if (rules.some((r) => matchSection(r, s))) corpusHits++;
    if (!corpusHits) {
      const offCampus = (g.courses ?? []).some((c) => !/\bHM$/.test(norm(c)));
      if (offCampus) notes.push(`${tag} / "${g.name}": matches no HM section (off-campus codes only)`);
      else zeroGroups.push(g.name);
    }
  }
  if (!hits && !corpus.some((s) => (set.groups ?? []).some((g) => compileRules(g).rules.some((r) => matchSection(r, s)))))
    fail(`${tag}: matches 0 of ${corpus.length} ${CODE} sections (and 0 of the ${sections.length} sample)`);
  rows.push({
    id: set.id,
    kind: set.kind,
    groups: set.groups?.length ?? 0,
    hits,
    zeroGroups: zeroGroups.join("; "),
  });
}

console.log("\nper set (sampled sections matching at least one group / " + sections.length + "):");
for (const r of rows)
  console.log(
    `  ${String(r.kind).padEnd(5)} ${String(r.groups).padStart(2)} groups  ${String(r.hits).padStart(3)} hits  ${r.id}` +
      (r.zeroGroups ? `   [matches no HM section: ${r.zeroGroups}]` : ""),
  );

console.log(
  `\ncourse-code resolution: ${resolved.length}/${allCodes.size} (${hitRate.toFixed(1)}%)`,
);
if (unresolved.length) {
  console.log("unresolved (can never match a synced section):");
  for (const u of unresolved) console.log("  - " + u);
}
if (areaRulesSeen) notes.push(`${areaRulesSeen} area rule(s) present but not evaluable from sections`);
for (const n of notes) console.log("  ! " + n);
console.log(`\nsets: ${rows.length} (${rows.filter((r) => r.kind === "major").length} major / ${rows.filter((r) => r.kind === "minor").length} minor)`);
console.log(`errors: ${errors.length}`);
console.log(errors.length ? "FAIL" : "PASS");
process.exit(errors.length ? 1 : 0);
