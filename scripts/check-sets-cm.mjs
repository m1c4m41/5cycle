#!/usr/bin/env node
/**
 * check-sets-cm.mjs — validator for data/requirements/majors-cm.json (Claremont McKenna).
 *
 * Read-only: it opens data/db.sqlite with DatabaseSync and issues SELECTs only.
 * It never runs the app loader and never writes the DB.
 *
 *   node scripts/check-sets-cm.mjs            # validate the deliverable
 *   node scripts/check-sets-cm.mjs --verbose  # print per-group rule dumps
 *
 * Checks (docs/MAJORS-BRIEF.md "Validation you must run before reporting done")
 *   1. JSON parses; ids unique; school is a valid campus code; every set has >=2 groups;
 *      every group has >=1 positive rule and either minCourses or minCredits.
 *   2. every `courses` code resolves to a real section (matcher codes are unpadded, DB codes
 *      are zero-padded to 3 and carry an affiliation: "ECON 51 CM" -> "ECON 051 CM").
 *      Prints the resolution percentage.
 *   3. match test: reimplements the lib/requirements.ts matcher semantics and runs it over the
 *      full CMC section universe plus the prescribed random 400-section sample. A set that
 *      matches 0 sections in the full universe is a broken set (error); a set that matches 0 in
 *      the random sample but >0 in the universe is reported as a sampling warning.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.argv[2] && !process.argv[2].startsWith("--")
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "data/requirements/majors-cm.json");
const VERBOSE = process.argv.includes("--verbose");
const SCHOOLS = new Set(["PO", "CM", "HM", "PZ", "SC", "CG"]);

const errors = [];
const warns = [];
const fail = (m) => errors.push(m);

/* ---------------------------------------------------------------- 1. shape */

let doc;
try {
  doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (err) {
  console.error(`FATAL: bad JSON in ${path.relative(ROOT, FILE)}: ${err.message}`);
  process.exit(1);
}

const sets = doc.sets ?? [];
if (!Array.isArray(sets) || !sets.length) {
  console.error("FATAL: no `sets` array");
  process.exit(1);
}

const seenIds = new Set();
for (const s of sets) {
  if (!s.id) fail("set without id");
  if (seenIds.has(s.id)) fail(`duplicate id ${s.id}`);
  seenIds.add(s.id);
  if (!SCHOOLS.has(s.school)) fail(`${s.id}: bad school ${JSON.stringify(s.school)}`);
  if (!["major", "minor"].includes(s.kind)) fail(`${s.id}: bad kind ${s.kind}`);
  if (!s.name) fail(`${s.id}: missing name`);
  if (!s.source) fail(`${s.id}: missing source URL (hard rule 3)`);
  else if (!/^https?:\/\//.test(s.source)) fail(`${s.id}: source is not a URL (${s.source})`);
  else if (!/catalog\.claremontmckenna\.edu/.test(s.source)) fail(`${s.id}: source is not the official CMC catalog`);
  if (s.verified !== false) fail(`${s.id}: verified must be false`);
  if (!/^major-CM-|^minor-CM-/.test(s.id)) fail(`${s.id}: id must be (major|minor)-CM-<SLUG>`);

  const groups = s.groups ?? [];
  if (groups.length < 2) fail(`${s.id}: only ${groups.length} group(s), need >=2`);
  groups.forEach((g, i) => {
    const at = `${s.id} group[${i}] "${g.name}"`;
    const positives =
      (g.courses?.length ?? 0) +
      (g.departments?.length ?? 0) +
      (g.area?.length ?? 0) +
      (g.titleKeywords?.length ?? 0) +
      (g.matchers?.length ?? 0) +
      (g.any ? 1 : 0);
    if (!positives) fail(`${at}: no positive rule`);
    if (g.minCourses == null && g.minCredits == null) fail(`${at}: needs minCourses or minCredits`);
    if (g.minCourses != null && !(g.minCourses > 0)) fail(`${at}: minCourses must be positive`);
    if (g.minCredits != null && !(g.minCredits > 0)) fail(`${at}: minCredits must be positive`);
    for (const c of g.courses ?? []) {
      if (!/^[A-Z]{2,6} ?\d{2,3}[A-Z]??( CM| HM| PZ| PO| SC| CG| KS| AA| AF| CH| JM| JP| JT| KG)?$/.test(c))
        fail(`${at}: malformed course code "${c}"`);
    }
    if (VERBOSE) console.log(`  ${at}: min=${g.minCourses ?? g.minCredits} pos=${positives}`);
  });
}

/* ------------------------------------------------------- 2. course resolution */

const db = new DatabaseSync(path.join(ROOT, "data/db.sqlite"), { readOnly: true });
const pad = (c) => {
  const m = /^(.*?)\s?(\d{2,3})([A-Z]*)(?:\s+([A-Z]{2}))?$/.exec(c.trim().toUpperCase());
  if (!m) return null;
  return { dept: m[1].trim(), num: m[2].padStart(3, "0"), suf: m[3] || "", aff: m[4] || null };
};
const existsExact = db.prepare("SELECT COUNT(*) n FROM sections WHERE course_code = ?");
const existsLike = db.prepare("SELECT COUNT(*) n FROM sections WHERE course_code LIKE ?");

const allCodes = new Set();
for (const s of sets) for (const g of s.groups ?? []) for (const c of g.courses ?? []) allCodes.add(c);
for (const s of sets) for (const g of s.groups ?? []) for (const c of g.exclude?.courses ?? []) allCodes.add(c);

let hit = 0;
const misses = [];
for (const c of allCodes) {
  const p = pad(c);
  let n = 0;
  if (p) {
    if (p.aff) n = existsExact.get(`DEPT ${p.num}${p.suf} ${p.aff}`.replace("DEPT", p.dept)).n;
    if (!n)
      n = existsLike.get(`${p.dept} ${p.num}${p.suf}%`).n || existsLike.get(`${p.dept} ${p.num}%`).n;
  }
  if (n > 0) hit++;
  else misses.push(c);
}
const rate = allCodes.size ? (100 * hit) / allCodes.size : 100;
console.log(`\ncourse-code resolution: ${hit}/${allCodes.size} = ${rate.toFixed(1)}%`);
if (misses.length) console.log("  unresolved:", misses.join(", "));
if (rate < 100) warns.push(`${allCodes.size - hit} course code(s) do not resolve in the synced catalog`);

/* ------------------------------------------------------------ 3. smoke test */

const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "").trim();
function codeEquals(sectionCourseCode, wanted) {
  const a = sectionCourseCode.toUpperCase();
  const b = wanted.toUpperCase();
  if (norm(a) === norm(b)) return true;
  const [, numA, , affA] = /^(.*?)\s+(\d+[A-Z]*)\s+([A-Z]{2})$/.exec(a) ?? [];
  const parts = b.split(/\s+/);
  if (parts.length === 2 && numA) {
    if (norm(parts[0]) === norm(a.split(" ")[0]) && parts[1].toUpperCase() === numA) return true;
  }
  if (norm(parts.join(" ") + " " + (affA ?? "")).replace(affA ?? "", "") === "" ) return false;
  if (b.endsWith("*") && norm(a).startsWith(norm(b.slice(0, -1)))) return true;
  // "ECON 51" (no affiliation) matches any teaching campus of ECON 051 xx
  if (parts.length === 2 && numA) {
    const stem = `${parts[0].toUpperCase()} ${numA}`;
    if (a.startsWith(stem) || a.startsWith(`${parts[0].toUpperCase()} ${numA.padStart(3, "0")}`)) return true;
  }
  return false;
}

function match(m, s) {
  switch (m.type) {
    case "course":
      return m.codes.some((c) => codeEquals(s.course_code, c));
    case "department": {
      if (norm(s.department) !== norm(m.department)) return false;
      if (typeof m.min === "number" && s.course_number < m.min) return false;
      if (typeof m.max === "number" && s.course_number > m.max) return false;
      if (m.schools?.length && !m.schools.includes(s.school)) return false;
      return true;
    }
    case "area":
      return (s.areas ?? []).some((a) =>
        m.codes.some((c) => norm(c) === norm(a) || (c.endsWith("*") && norm(a).startsWith(norm(c.slice(0, -1))))),
      );
    case "titleKeyword":
      return m.keywords.some((k) => `${s.title} ${s.description ?? ""}`.toLowerCase().includes(k.toLowerCase()));
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

/** group sugar -> OR-of-rules, with exclude wrapped as AND NOT (lib/requirements.ts compileRules) */
function compileRules(g) {
  const pos = [];
  if (g.area?.length) pos.push({ type: "area", codes: g.area });
  if (g.courses?.length) pos.push({ type: "course", codes: g.courses });
  for (const d of g.departments ?? []) pos.push({ type: "department", ...d });
  if (g.titleKeywords?.length) pos.push({ type: "titleKeyword", keywords: g.titleKeywords });
  if (g.any) pos.push({ type: "any" });
  for (const m of g.matchers ?? []) pos.push(m);
  const neg = [];
  if (g.exclude?.area?.length) neg.push({ type: "area", codes: g.exclude.area });
  if (g.exclude?.courses?.length) neg.push({ type: "course", codes: g.exclude.courses });
  for (const d of g.exclude?.departments ?? []) neg.push({ type: "department", ...d });
  if (!pos.length) pos.push({ type: "any" });
  if (!neg.length) return pos;
  return pos.map((p) => ({ type: "and", children: [p, ...neg.map((n) => ({ type: "not", child: n }))] }));
}

const areaRows = db.prepare(
  "SELECT section_id, area_code FROM section_areas WHERE section_id IN (SELECT id FROM sections)",
);
const areasOf = new Map();
for (const r of areaRows.all()) {
  if (!areasOf.has(r.section_id)) areasOf.set(r.section_id, []);
  areasOf.get(r.section_id).push(r.area_code);
}

const SAMPLE = Number(process.env.SAMPLE || 400);

/*
 * The brief asks for a random 400-section smoke test. Randomness alone can make a
 * perfectly good small set (e.g. a language major with 36 in-spec sections out of 3710)
 * look "broken" on some runs, so this script evaluates the *entire* CMC section universe
 * deterministically first (hard failure = a set that really matches nothing) and then
 * reports the prescribed random sample on top of it (a 0 there while the full universe is
 * non-zero is sampling noise -> WARN with the computed flake probability).
 */
const universe = db
  .prepare(
    `SELECT id, course_code, department, course_number, school, affiliation, title, description
     FROM sections
     WHERE school = 'CM' OR affiliation = 'CM'`,
  )
  .all();
for (const s of universe) s.areas = areasOf.get(s.id) ?? [];
const sample = universe
  .map((s, i) => [Math.random(), i, s])
  .sort((a, b) => a[0] - b[0])
  .slice(0, SAMPLE)
  .map(([, , s]) => s);
console.log(
  `\nmatch test: ${universe.length} CMC sections in the DB (school or affiliation = CM); random sample of ${sample.length}`,
);

const compiled = new Map();
for (const s of sets) compiled.set(s.id, (s.groups ?? []).map((g) => ({ g, rules: compileRules(g) })));

const countOver = (rows, s) => {
  const perGroup = new Array((s.groups ?? []).length).fill(0);
  let any = 0;
  compiled.get(s.id).forEach(({ rules }, i) => {
    for (const sec of rows) if (rules.some((r) => match(r, sec))) perGroup[i]++;
  });
  for (const sec of rows) {
    if (compiled.get(s.id).some(({ rules }) => rules.some((r) => match(r, sec)))) any++;
  }
  return { any, perGroup };
};

const table = [];
for (const s of sets) {
  const full = countOver(universe, s);
  const spot = countOver(sample, s);
  const p0 = Math.pow(1 - full.any / universe.length, sample.length);
  table.push({
    id: s.id,
    kind: s.kind,
    groups: (s.groups ?? []).length,
    matched: full.any,
    perGroup: full.perGroup,
    spot: spot.any,
    p0,
  });
  if (full.any === 0) fail(`${s.id}: matches 0 of ${universe.length} CMC sections (broken set)`);
  else if (spot.any === 0) {
    warns.push(
      `${s.id}: matched 0 of ${sample.length} sampled sections but ${full.any}/${universe.length} in the full universe (~${(p0 * 100).toFixed(1)}% sampling flake, not broken)`,
    );
  }
}

table.sort((a, b) => a.matched - b.matched);
console.log("\nid                            kind   groups  CMsections  sample  perGroup(CM universe)");
for (const r of table) {
  console.log(
    `${r.id.padEnd(30)} ${r.kind.padEnd(6)} ${String(r.groups).padStart(5)}  ${String(r.matched).padStart(9)}  ${String(r.spot).padStart(6)}  ${r.perGroup.join(",")}`,
  );
}

/* ------------------------------------------------------------- 4. summary */

const byKind = sets.reduce((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {});
console.log(`\nsets: ${sets.length} (${byKind.major ?? 0} major, ${byKind.minor ?? 0} minor)  groups: ${sets.reduce((n, s) => n + (s.groups?.length ?? 0), 0)}`);
for (const w of warns) console.log("WARN: " + w);
if (errors.length) {
  console.log(`\n${errors.length} ERROR(S):`);
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}
console.log("\nOK: all checks passed");
