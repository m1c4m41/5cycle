#!/usr/bin/env node
/**
 * check-sets-pz.mjs — validator for data/requirements/majors-pz.json (Pitzer).
 *
 * Read-only: opens data/db.sqlite with node:sqlite in readOnly mode and issues
 * SELECTs only. It never writes to the DB and never runs the app loader.
 *
 * Checks (per docs/MAJORS-BRIEF.md):
 *   1. JSON parses; ids unique; school === "PZ"; kind major|minor; verified === false;
 *      every set has >=2 groups; every group has >=1 positive rule plus
 *      minCourses or minCredits.
 *   2. every `courses` code (including matchers/exclusions) resolves to a real
 *      section under the same semantics as codeEquals() in lib/requirements.ts:
 *        - full "DEPT NUM AFF" codes must exist verbatim (numbers zero-padded)
 *        - bare "DEPT NUM" codes match any affiliation
 *        - trailing "*" codes are prefix matches
 *      Reports the resolution hit rate and lists codes that can never match.
 *   3. match smoke test against 400 random PZ sections using a copy of the matcher
 *      semantics in lib/requirements.ts. Sets matching 0 sections are flagged.
 *
 * Usage: node scripts/check-sets-pz.mjs [path/to/file.json]
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "data/requirements/majors-pz.json");
const DB = path.join(ROOT, "data/db.sqlite");
const CODE = "PZ";
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
      // The synced `sections` table exposes no registrar area codes, so area rules
      // are counted but cannot be evaluated here.
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
      return m.keywords.some(
        (k) => String(k).toLowerCase().length && hay.includes(String(k).toLowerCase()),
      );
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
    ? positives.map((p) => ({
        type: "and",
        children: [p, { type: "not", child: { type: "or", children: neg } }],
      }))
    : positives;
  return { positives, rules };
}

/* ------------------------------ course codes ----------------------------- */
const db = new DatabaseSync(DB, { readOnly: true });

/** All distinct course codes in the synced catalog. */
const dbCodes = db
  .prepare("SELECT DISTINCT course_code AS c FROM sections")
  .all()
  .map((r) => r.c)
  .filter(Boolean);
const codeSet = new Set(dbCodes.map(norm));

/** "DEPT NUM" (no affiliation) -> does any affiliation exist? */
const bareSet = new Set();
for (const c of dbCodes) {
  const m = /^([A-Z]+)\s+(\d+[A-Z]*)\s+([A-Z]{2})$/.exec(norm(c));
  if (m) bareSet.add(`${m[1]} ${m[2]}`);
}

/** "ENGR 85A HM" -> "ENGR 085A HM" (DB pads numbers to 3 digits). */
function padCode(code) {
  const m = /^([A-Z]+)\s+(\d+[A-Z]*)\s+([A-Z]{2})$/.exec(norm(code));
  if (!m) return null;
  const digits = m[2].replace(/[A-Z]+$/, "");
  const suffix = m[2].slice(digits.length);
  return digits.length >= 3 ? `${m[1]} ${m[2]} ${m[3]}` : `${m[1]} ${digits.padStart(3, "0")}${suffix} ${m[3]}`;
}

/** Resolve a wanted code against the DB the same way codeEquals() would at runtime. */
function resolveCode(code) {
  const b = norm(code);
  if (b.endsWith("*")) {
    const pre = norm(b.slice(0, -1));
    const hit = dbCodes.find((c) => norm(c).startsWith(pre));
    return hit ? { ok: true, as: `prefix ${pre}*` } : { ok: false, as: `prefix ${pre}*` };
  }
  const parts = b.split(" ");
  if (parts.length === 2) {
    const bare = `${norm(parts[0])} ${norm(parts[1])}`;
    if (bareSet.has(bare)) return { ok: true, as: `${bare} (any affiliation)` };
    // tolerate unpadded bare numbers, e.g. "ECON 51"
    const digits = parts[1].replace(/[A-Z]+$/, "");
    const suffix = parts[1].slice(digits.length);
    const padded = `${norm(parts[0])} ${digits.padStart(3, "0")}${suffix}`;
    if (bareSet.has(padded)) return { ok: true, as: `${padded} (any affiliation)` };
    return { ok: false, as: `${bare} (bare)` };
  }
  if (parts.length === 3) {
    const padded = padCode(b);
    if (padded && codeSet.has(norm(padded))) return { ok: true, as: padded };
    if (codeSet.has(b)) return { ok: true, as: b };
    return { ok: false, as: padded ?? b };
  }
  return { ok: false, as: b };
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
console.log(`check-sets-pz: ${path.relative(ROOT, FILE)}`);

let doc;
try {
  doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  console.error("FATAL: JSON.parse failed: " + e.message);
  process.exit(1);
}

if (!Array.isArray(doc.sets) || !doc.sets.length) fail("file has no sets[]");
if (!doc._comment) notes.push("no top-level _comment provenance note");

const allCodes = new Set();
for (const set of doc.sets ?? []) for (const g of set.groups ?? []) collectCodes(g, allCodes);

const resolved = [];
const unresolved = [];
for (const code of [...allCodes].sort()) {
  const r = resolveCode(code);
  (r.ok ? resolved : unresolved).push(`${code}${r.ok ? ` (as ${r.as})` : ` (as ${r.as})`}`);
}
const hitRate = allCodes.size ? (resolved.length / allCodes.size) * 100 : 100;

/** Every PZ-campus section in the synced catalog — used for the strict pass. */
const corpus = db
  .prepare(
    `SELECT course_code, department, course_number, school, title, description
       FROM sections WHERE school = ?`,
  )
  .all(CODE);
/** The brief's smoke-test sample: 400 random PZ sections. */
const sections = [...corpus].sort(() => Math.random() - 0.5).slice(0, SAMPLE);

/**
 * Pitzer's bulletin is intercollegiate: biology/chemistry/physics/math statistics
 * requirements are satisfied at Keck, HMC, Pomona and CMC, so a faithful Pitzer
 * group can legitimately contain no school='PZ' section at all. A group or set is
 * only "broken" when it matches nothing anywhere in the synced catalog, so the
 * strict pass also scans the full 5C catalog with an early exit on first hit.
 */
const wide = db
  .prepare(
    `SELECT course_code, department, course_number, school, title, description FROM sections`,
  )
  .all();
const wideSample = [...wide].sort(() => Math.random() - 0.5).slice(0, SAMPLE);
console.log(
  `corpus: ${corpus.length} ${CODE} sections (${sections.length} sampled) | 5C corpus: ${wide.length} sections (${wideSample.length} sampled)`,
);

/** Short human label for a compiled positive rule, used in dead-rule messages. */
function describe(m) {
  switch (m.type) {
    case "course":
      return `course ${JSON.stringify(m.codes)}`;
    case "department":
      return `department ${m.department}${m.min != null || m.max != null ? ` ${m.min ?? 0}-${m.max ?? "inf"}` : ""}${m.schools?.length ? ` schools=${m.schools}` : ""}`;
    case "titleKeyword":
      return `titleKeyword ${JSON.stringify(m.keywords)}`;
    case "area":
      return `area ${JSON.stringify(m.codes)}`;
    case "any":
      return "any";
    default:
      return m.type;
  }
}

const matchesAny = (rules, rows) => {
  for (const s of rows) if (rules.some((r) => matchSection(r, s))) return true;
  return false;
};
const countHits = (rules, rows) => rows.filter((s) => rules.some((r) => matchSection(r, s))).length;

const ids = new Set();
const out = [];
for (const set of doc.sets ?? []) {
  const tag = set.id ?? "(missing id)";
  if (ids.has(set.id)) fail(`${tag}: duplicate id`);
  ids.add(set.id);
  if (set.school !== CODE) fail(`${tag}: school=${set.school}, must be ${CODE}`);
  if (!["major", "minor"].includes(set.kind)) fail(`${tag}: kind must be major|minor (${set.kind})`);
  if (!set.name) fail(`${tag}: missing name`);
  if (set.verified !== false) fail(`${tag}: verified must be false`);
  if (!/^https?:\/\/.+/.test(set.source ?? "")) fail(`${tag}: source must be an exact scraped URL`);
  if (!/preview_program\.php/.test(set.source ?? "")) fail(`${tag}: source should be a catalog preview_program page`);
  if (!set.notes) notes.push(`${tag}: no notes for catalog provenance`);
  if (!Array.isArray(set.groups) || set.groups.length < 2)
    fail(`${tag}: needs >=2 groups (has ${set.groups?.length ?? 0})`);

  const zeroGroups = [];
  const interGroups = [];
  const deadRules = [];
  let hits = 0;
  for (const s of sections) {
    for (const g of set.groups ?? []) {
      if (compileRules(g).rules.some((r) => matchSection(r, s))) {
        hits++;
        break;
      }
    }
  }
  for (const g of set.groups ?? []) {
    const { positives, rules } = compileRules(g);
    if (!positives.length) fail(`${tag} / "${g.name}": no positive rule`);
    if (g.minCourses == null && g.minCredits == null)
      fail(`${tag} / "${g.name}": needs minCourses or minCredits`);
    if (g.minCredits != null && !/(scale|credit|1\.0|5C)/i.test((g.notes ?? "") + (set.notes ?? "")))
      notes.push(`${tag} / "${g.name}": minCredits without a 5C credit-scale note`);
    if (g.titleKeywords?.some((k) => String(k).trim().length < 4))
      notes.push(`${tag} / "${g.name}": very short titleKeyword may over-match`);
    const pzHits = countHits(rules, corpus);
    if (!pzHits) {
      // Intercollegiate reality check: does the rule fire anywhere in the 5C catalog?
      if (matchesAny(rules, wide)) interGroups.push(g.name);
      else zeroGroups.push(g.name);
    }
    // Each individual positive rule must be able to fire somewhere in the synced
    // catalog, otherwise it is a dead rule inside the group's OR (brief rule 4).
    // Area rules are skipped: sections carries no area data, so they are unverifiable here.
    for (const p of positives) {
      if (p.type === "area") continue;
      if (!matchesAny([p], wide)) deadRules.push(`${g.name}: ${describe(p)}`);
    }
  }
  const pzSetHits = countHits(
    (set.groups ?? []).flatMap((g) => compileRules(g).rules),
    corpus,
  );
  if (zeroGroups.length)
    fail(`${tag}: group(s) can never match any synced section: ${zeroGroups.join("; ")}`);
  if (deadRules.length)
    fail(`${tag}: dead positive rule(s) that match no synced section: ${deadRules.join("; ")}`);
  if (!pzSetHits && !matchesAny((set.groups ?? []).flatMap((g) => compileRules(g).rules), wide))
    fail(`${tag}: matches 0 of ${corpus.length} ${CODE} sections and 0 of ${wide.length} 5C sections`);
  out.push({
    id: set.id,
    kind: set.kind,
    groups: set.groups?.length ?? 0,
    hits,
    pzSetHits,
    wide: matchesAny((set.groups ?? []).flatMap((g) => compileRules(g).rules), wide) ? "yes" : "NO",
    interGroups: interGroups.join("; "),
    zeroGroups: zeroGroups.join("; "),
  });
}

console.log("\nper set (sampled /" + sections.length + " PZ | PZ corpus /" + corpus.length + "):");
for (const r of out)
  console.log(
    `  ${String(r.kind).padEnd(5)} ${String(r.groups).padStart(2)} groups  ${String(r.hits).padStart(3)} s-hits  ${String(r.pzSetHits).padStart(4)} pz  5C:${r.wide.padEnd(3)} ${r.id}` +
      (r.interGroups ? `   [intercollegiate-only groups: ${r.interGroups}]` : "") +
      (r.zeroGroups ? `   [NEVER MATCHES: ${r.zeroGroups}]` : ""),
  );

console.log(`\ncourse-code resolution: ${resolved.length}/${allCodes.size} (${hitRate.toFixed(1)}%)`);
if (unresolved.length) {
  console.log("unresolved (can never match a synced section):");
  for (const u of unresolved) console.log("  - " + u);
}
if (areaRulesSeen) notes.push(`${areaRulesSeen} area rule(s) present but not evaluable from sections`);
for (const n of notes) console.log("  ! " + n);
console.log(
  `\nsets: ${out.length} (${out.filter((r) => r.kind === "major").length} major / ${out.filter((r) => r.kind === "minor").length} minor)`,
);
console.log(`errors: ${errors.length}`);
console.log(errors.length ? "FAIL" : "PASS");
process.exit(errors.length ? 1 : 0);
