/**
 * End-to-end verification of the planner loop against the real catalog:
 *   add a course -> requirement groups tick -> remove -> untick
 * Plus conflict detection, the force-add override, and term-summary math.
 *
 *   node scripts/verify-planner.mjs [TERM]
 *
 * Runs against data/db.sqlite directly (same code paths the Server Actions use),
 * and restores the QA student's plan to whatever it was when it started.
 */
import "../scripts/register.mjs";

const { get, all } = await import("@/lib/db");
const {
  addToSchedule,
  removeFromSchedule,
  enrolledSections,
  findConflicts,
  summarizeTerm,
} = await import("@/lib/schedule");
const { progressForUser, setsForUser } = await import("@/lib/requirements");

const TERM = process.argv[2] || "FA2026";
const user = await get("SELECT * FROM users WHERE email = ?", ["qa@5cycle.app"]);
if (!user) throw new Error("qa@5cycle.app missing — the QA test account should exist in data/db.sqlite");

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) fail++;
};

/** All currently-tickled groups, as a comparable set of "setId::groupId". */
async function ticks(sections) {
  const out = new Set();
  for (const p of await progressForUser(user, sections)) {
    for (const g of p.groups) if (g.satisfied) out.add(`${p.set.id}::${g.group.id}`);
  }
  return out;
}

console.log(`== ${user.name} <${user.email}> ${user.school} / major=${user.major_id} minor=${user.minor_id}`);
console.log(`== requirement sets in play (term ${TERM})`);
for (const s of await setsForUser(user)) {
  console.log(`   ${s.kind.padEnd(5)} ${s.id.padEnd(22)} ${s.name}  [${s.groups.length} groups]`);
}

const original = (await enrolledSections(user.id, TERM)).map((s) => s.id);
console.log(`\n== baseline plan: ${original.length} course(s) in ${TERM}`);
const t0 = await ticks(await enrolledSections(user.id, TERM));
console.log(`   satisfied groups: ${t0.size}`);

/* ---- find a course that actually advances the checklist ---- */
const pool = await all(
  `SELECT id, department, course_number, title FROM sections
    WHERE term_id = ? AND school <> 'UN' ORDER BY RANDOM() LIMIT 400`,
  [TERM],
);
let pick = null;
for (const c of pool) {
  const r = await addToSchedule(user.id, c.id, {});
  if (!r.ok) continue;
  const now = await ticks(await enrolledSections(user.id, TERM));
  const gained = [...now].filter((x) => !t0.has(x));
  if (gained.length) {
    pick = { ...c, gained };
    break;
  }
  await removeFromSchedule(user.id, c.id);
}

console.log("\n== tick / untick");
if (!pick) {
  fail++;
  console.log("  FAIL  none of the 400 sampled courses ticked a single requirement group");
} else {
  console.log(`  ${pick.id}  ${pick.title?.slice(0, 60)}`);
  pick.gained.forEach((g) => console.log(`        + ${g}`));
  ok(true, `adding ${pick.id} ticked ${pick.gained.length} group(s)`);

  const removed = await removeFromSchedule(user.id, pick.id);
  const after = await ticks(await enrolledSections(user.id, TERM));
  const stuck = pick.gained.filter((g) => after.has(g));
  ok(removed === true, "removeFromSchedule returned true");
  ok(stuck.length === 0, stuck.length ? `STILL TICKED after removal: ${stuck.join(", ")}` : "ticks cleared on removal (no sticky checkmarks)");
  ok(after.size === t0.size, "checklist returned to baseline exactly");

  // re-add and confirm the same groups return (deterministic matching)
  await addToSchedule(user.id, pick.id, {});
  const again = await ticks(await enrolledSections(user.id, TERM));
  ok(
    pick.gained.every((g) => again.has(g)),
    "re-adding reproduces the same ticks (matching is deterministic)",
  );
  await removeFromSchedule(user.id, pick.id);
}

/* ---- conflicts ---- */
console.log("\n== conflict guard + force-add override");
const timed = await all(
  `SELECT DISTINCT s.id FROM sections s JOIN section_schedules ss ON ss.section_id = s.id
    WHERE s.term_id = ? AND ss.start_time IS NOT NULL LIMIT 600`,
  [TERM],
);
let tried = 0;
for (const c of timed) {
  const r = await addToSchedule(user.id, c.id, {});
  if (r.ok) {
    await removeFromSchedule(user.id, c.id);
    continue;
  }
  tried++;
  if (!r.conflicts?.length) continue;
  console.log(`  blocked ${c.id}: ${String(r.error).slice(0, 110)}`);
  ok(true, "a time-overlapping course is refused without force");
  const f = await addToSchedule(user.id, c.id, { force: true });
  ok(f.ok === true, "force-add overrides the conflict guard");
  const live = findConflicts(await enrolledSections(user.id, TERM));
  ok(live.length > 0, `planner surfaces the forced overlap (${live.length} conflict pair(s))`);
  live.slice(0, 3).forEach((x) => console.log(`        ! ${x.a.id} ⨯ ${x.b.id}`));
  await removeFromSchedule(user.id, c.id);
  ok(findConflicts(await enrolledSections(user.id, TERM)).length === 0, "conflict disappears after removing the forced course");
  break;
}
if (!tried) console.log("  (sample produced no conflicts — try a fuller term)");

/* ---- summary ---- */
console.log("\n== term summary");
const sum = await summarizeTerm(user.id, TERM, user.school);
console.log(`   ${JSON.stringify(sum)}`);
ok(sum.termId === TERM, "summary reports the requested term");
const plan = await enrolledSections(user.id, TERM);
ok(sum.count === plan.length, `summary count matches enrollments (${plan.length})`);

/* ---- restore ---- */
for (const id of (await enrolledSections(user.id, TERM)).map((s) => s.id)) {
  if (!original.includes(id)) await removeFromSchedule(user.id, id);
}
const restored = (await enrolledSections(user.id, TERM)).map((s) => s.id).sort();
console.log(`\n== plan restored: ${restored.length === original.length ? "YES" : "NO"} (${restored.length}/${original.length})`);

console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
