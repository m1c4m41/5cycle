/**
 * CLI: pull the live 5C catalog into data/db.sqlite.
 *
 *   npm run sync                 # current term + the next few
 *   npm run sync -- SP2027       # one term, forced
 *   npm run sync -- --areas      # course-area definitions only
 *
 * Catalog writes go through lib/autosync's manualSync(), which takes the
 * same file lock as the background auto-sync and the /admin buttons — so a
 * CLI sync can never race a running one (it prints a notice and exits 1
 * instead).
 *
 * Requires Node >= 22.5 (built-in node:sqlite) and >= 23 for native type
 * stripping, which is what lets this script import the app's .ts libraries.
 */
import "../scripts/register.mjs";

const args = process.argv.slice(2).filter(Boolean);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const terms = args.filter((a) => !a.startsWith("--"));

const { syncCourseAreas, catalogStats } = await import("@/lib/ingest");
const { manualSync } = await import("@/lib/autosync");
const { loadRequirementFiles, listSets } = await import("@/lib/requirements");

if (flags.has("--areas")) {
  const n = await syncCourseAreas(true);
  console.log(`course areas: ${n}`);
} else {
  console.log(terms.length ? "syncing requested term(s)… (locked via manualSync)" : "bootstrapping from HyperSchedule v4…");
  let skipped = false;
  for (const t of terms.length ? terms : [undefined]) {
    const res = await manualSync(t);
    if (res.skipped) {
      console.error(`skipped: ${res.skipped}`);
      skipped = true;
      continue;
    }
    for (const r of res.reports ?? []) {
      console.log(
        `  ${r.term}: ${r.sections} sections, ${r.meetings} meetings, ${r.instructors} professors (${r.ms}ms)`,
      );
    }
    if (res.current) console.log(`current term: ${res.current}`);
  }
  if (skipped) process.exitCode = 1;
}

const req = loadRequirementFiles();
console.log(`requirements: ${req.sets} sets, ${req.groups} groups loaded`);
console.log(`  majors: ${listSets({ kind: "major" }).length}, minors: ${listSets({ kind: "minor" }).length}, GE: ${listSets({ kind: "ge" }).length}`);

const s = catalogStats();
console.log(
  `catalog now: ${s.sections} sections / ${s.courses} courses / ${s.instructors} professors / ${s.areas} areas`,
);
console.log(`terms: ${s.terms.map((t) => `${t.id}${t.is_current ? "*" : ""}(${t.id && t.synced_at ? 1 : 0})`).join(" ")}`);
