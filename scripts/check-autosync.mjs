/**
 * Regression check for catalog auto-sync (lib/autosync.ts).
 *
 * Fully hermetic: works on a VACUUM-INTO snapshot of data/db.sqlite in
 * /tmp/autosync-test and a local mock of the HyperSchedule v4 API that
 * proxies real upstream responses while injecting two synthetic terms:
 *
 *   FA2027  — "newly published": listed in /v4/term/all with real-shaped
 *             section data (2 sections) → must be detected + ingested.
 *   SU2028  — "listed but not loaded yet": in the term list, its
 *             /v4/sections 404s for the first ticks, then resolves →
 *             must be marked pending, retried, then ingested.
 *
 * Assertions: new-term detection, the current term following the calendar
 * season (not upstream's "current"), enrollment preservation across a full
 * re-sync of SP2027, pending→retried→resolved lifecycle, steady-state
 * probe-only ticks, the file lock, and the background loop start/stop.
 *
 *   npm run autosync-check
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import "../scripts/register.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIR = "/tmp/autosync-test";
const MOCK_PORT = 8791;
const UPSTREAM = "https://banana.hyperschedule.io";

function fail(msg) {
  console.error("FAIL  " + msg);
  process.exit(1);
}
let passed = 0;
function ok(msg) {
  passed++;
  console.log("  ok  " + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The app decides the current term by calendar season (Jul–Dec → FA{year},
// Jan–Jun → SP{year}), not by upstream /v4/term/current. Assert against the
// same rule so the script passes whichever season it runs in.
const _now = new Date();
const SEASONAL_TERM = _now.getMonth() >= 6 ? `FA${_now.getFullYear()}` : `SP${_now.getFullYear()}`;

/* ------------------------- 1. DB snapshot + baseline ------------------------ */

fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_DIR, "cache"), { recursive: true });

for (let attempt = 1; ; attempt++) {
  try {
    const src = new DatabaseSync(path.join(ROOT, "data/db.sqlite"));
    src.exec("PRAGMA busy_timeout = 5000");
    src.exec(`VACUUM INTO '${TEST_DIR}/db.sqlite'`);
    src.close();
    // Match the app's WAL mode on the copy.
    const fix = new DatabaseSync(path.join(TEST_DIR, "db.sqlite"));
    fix.exec("PRAGMA journal_mode = WAL");
    fix.close();
    break;
  } catch (e) {
    if (attempt >= 3) fail("could not snapshot data/db.sqlite: " + e.message);
    await sleep(2000);
  }
}

const DB = () => new DatabaseSync(path.join(TEST_DIR, "db.sqlite"), { readOnly: true });
const base = (() => {
  const d = DB();
  const n = Number(d.prepare("SELECT COUNT(*) n FROM enrollments").get().n);
  const qa = Number(
    d
      .prepare(
        "SELECT COUNT(*) n FROM enrollments WHERE term_id='SP2027' AND user_id=(SELECT id FROM users WHERE email='qa@5cycle.app')",
      )
      .get().n,
  );
  const sections = Number(d.prepare("SELECT COUNT(*) n FROM sections").get().n);
  d.close();
  return { n, qa, sections };
})();
console.log(`baseline: ${base.n} enrollments (${base.qa} QA SP2027), ${base.sections} sections`);

// The snapshot may carry autosync_* meta from a running production loop
// (e.g. autosync_last_sections stamped during a steady-state probe). The
// assertions below are written against a clean tick history, so start from
// zero runs.
{
  const d = new DatabaseSync(path.join(TEST_DIR, "db.sqlite"));
  const n = Number(d.prepare("DELETE FROM meta WHERE key LIKE 'autosync%'").run().changes);
  d.close();
  console.log(`cleaned ${n} pre-existing autosync meta keys`);
}

/* ------------------------------ 2. mock v4 API ----------------------------- */

let sp2027Cache = null; // real SP2027 payload, used to fabricate the fake terms
let suResolved = false;

function transform(sec, term, year) {
  const s = structuredClone(sec);
  s.identifier.term = term;
  s.identifier.year = year;
  return s;
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  const p = url.pathname;
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  };
  try {
    if (p === "/v4/term/current") {
      const t = await (await fetch(UPSTREAM + p)).json();
      return send(200, JSON.stringify(t));
    }
    if (p === "/v4/term/all") {
      const real = await (await fetch(UPSTREAM + p)).json();
      const have = new Set(real.map((t) => `${t.term}${t.year}`));
      const list = [...real];
      if (!have.has("FA2027")) list.push({ term: "FA", year: 2027 });
      if (!have.has("SU2028")) list.push({ term: "SU", year: 2028 });
      return send(200, JSON.stringify(list));
    }
    if (p === "/v4/course-areas") {
      const a = await (await fetch(UPSTREAM + p)).json();
      return send(200, JSON.stringify(a));
    }
    const m = /^\/v4\/sections\/(FA|SP|SU)\d{4}$/.exec(p);
    if (m) {
      const term = m[1];
      const year = Number(p.slice(-4));
      if (term === "FA" && year === 2027) {
        if (!sp2027Cache)
          sp2027Cache = await (await fetch(UPSTREAM + "/v4/sections/SP2027")).json();
        return send(200, JSON.stringify([transform(sp2027Cache[0], "FA", 2027), transform(sp2027Cache[1], "FA", 2027)]));
      }
      if (term === "SU" && year === 2028) {
        if (!suResolved) return send(404, "");
        if (!sp2027Cache)
          sp2027Cache = await (await fetch(UPSTREAM + "/v4/sections/SP2027")).json();
        return send(200, JSON.stringify([transform(sp2027Cache[2] ?? sp2027Cache[0], "SU", 2028)]));
      }
      // Everything else: proxy the real upstream.
      const r = await fetch(UPSTREAM + p, { headers: { accept: "application/json" } });
      const body = await r.text();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    send(404, "");
  } catch (e) {
    send(502, JSON.stringify({ error: e.message }));
  }
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
console.log(`mock v4 API on 127.0.0.1:${MOCK_PORT} (proxy + FA2027/SU2028 injection)`);

/* ------------------------- 3. import app modules --------------------------- */

process.env.HYPERSCHEDULE_API = `http://127.0.0.1:${MOCK_PORT}`;
process.env.CYCLE_DATA_DIR = TEST_DIR;
process.env.CYCLE_DB_PATH = path.join(TEST_DIR, "db.sqlite");
process.env.CYCLE_CACHE_DIR = path.join(TEST_DIR, "cache");
process.env.CYCLE_AUTO_SYNC = "1";
process.env.CYCLE_AUTO_SYNC_STARTUP_DELAY_MS = "0";
process.env.CYCLE_AUTO_SYNC_MINUTES = "60";
process.env.CYCLE_SECTION_SYNC_HOURS = "4";

const {
  autoSyncTickOnce,
  getAutoSyncStatus,
  startAutoSync,
  stopAutoSync,
} = await import("@/lib/autosync");

const meta = (k) =>
  (() => {
    const d = DB();
    const v = d.prepare("SELECT value v FROM meta WHERE key=?").get(k)?.v;
    d.close();
    return v;
  })();

/* ------------------------------- 4. the ticks ------------------------------ */

console.log("tick 1: manual — should detect FA2027 + SU2028, ingest FA2027, mark SU2028 pending");
const priorCurrent = meta("current_term") ?? "";
let t1 = await autoSyncTickOnce("manual");
ok(`ok=${t1.ok}`);
ok(`new terms detected: [${t1.newTerms.sort().join(", ")}]`);
if (!t1.newTerms.includes("FA2027") || !t1.newTerms.includes("SU2028"))
  fail("FA2027/SU2028 not detected as new");
const expectCurrentChanged = priorCurrent !== "" && priorCurrent !== SEASONAL_TERM;
if (t1.currentChanged !== expectCurrentChanged)
  fail(`currentChanged=${t1.currentChanged}, expected ${expectCurrentChanged} (season term is ${SEASONAL_TERM}, snapshot said ${priorCurrent})`);
const t1fa = t1.terms.find((x) => x.term === "FA2027");
const t1su = t1.terms.find((x) => x.term === "SU2028");
if (t1fa?.status !== "synced" || t1fa.sections !== 2)
  fail(`FA2027 should be synced with 2 sections, got ${JSON.stringify(t1fa)}`);
ok("FA2027 synced with 2 sections");
if (t1su?.status !== "pending")
  fail(`SU2028 should be pending, got ${JSON.stringify(t1su)}`);
ok("SU2028 marked pending (404 upstream)");
if (meta("autosync_last_sections"))
  fail("autosync_last_sections must not be stamped while a term is pending");

console.log("verifying DB state after tick 1");
{
  const d = DB();
  const fa2027 = Number(d.prepare("SELECT COUNT(*) n FROM sections WHERE term_id='FA2027'").get().n);
  const su2028 = Number(d.prepare("SELECT COUNT(*) n FROM sections WHERE term_id='SU2028'").get().n);
  const cur = d.prepare("SELECT id FROM terms WHERE is_current=1").get()?.id;
  const enrs = Number(d.prepare("SELECT COUNT(*) n FROM enrollments").get().n);
  const qa = Number(
    d
      .prepare(
        "SELECT COUNT(*) n FROM enrollments WHERE term_id='SP2027' AND user_id=(SELECT id FROM users WHERE email='qa@5cycle.app')",
      )
      .get().n,
  );
  d.close();
  if (fa2027 !== 2) fail(`FA2027 sections in DB = ${fa2027}, want 2`);
  ok("FA2027 has 2 sections in DB");
  if (su2028 !== 0) fail(`SU2028 sections in DB = ${su2028}, want 0`);
  ok("SU2028 has no sections yet");
  if (cur !== meta("current_term") || cur !== SEASONAL_TERM)
    fail(`current term is ${cur}, want seasonal ${SEASONAL_TERM}`);
  ok(`current term is ${SEASONAL_TERM} (season rule, not upstream)`);
  if (enrs !== base.n || qa !== base.qa)
    fail(`enrollments changed: ${enrs}/${qa} vs baseline ${base.n}/${base.qa}`);
  ok(`enrollments preserved (${enrs} total, ${qa} QA SP2027)`);
}

console.log("tick 2: interval — pending term must be retried");
t1 = await autoSyncTickOnce("interval");
const t2su = t1.terms.find((x) => x.term === "SU2028");
if (!t1.terms.length) fail("interval tick should have re-synced (pending term from last report)");
if (t2su?.status !== "pending") fail(`SU2028 should still be pending, got ${JSON.stringify(t2su)}`);
ok("SU2028 retried, still pending");

console.log("mock: SU2028 sections now published upstream");
suResolved = true;

console.log("tick 3: interval — pending term resolves, sections stamp updates");
const t3 = await autoSyncTickOnce("interval");
const t3su = t3.terms.find((x) => x.term === "SU2028");
if (!t3.ok) fail(`tick 3 not ok: ${t3.error}`);
if (t3su?.status !== "synced" || t3su.sections !== 1)
  fail(`SU2028 should now be synced with 1 section, got ${JSON.stringify(t3su)}`);
ok("SU2028 picked up once upstream published it");
if (!meta("autosync_last_sections")) fail("autosync_last_sections should be stamped now");
ok("sections-fresh stamp updated");
{
  const d = DB();
  const n = Number(d.prepare("SELECT COUNT(*) n FROM sections WHERE term_id='SU2028'").get().n);
  const enrs = Number(d.prepare("SELECT COUNT(*) n FROM enrollments").get().n);
  d.close();
  if (n !== 1) fail(`SU2028 sections = ${n}, want 1`);
  if (enrs !== base.n) fail(`enrollments drifted to ${enrs}`);
  ok("DB matches: SU2028 = 1 section, enrollments intact");
}

console.log("tick 4: interval — steady state, probe only (no re-sync)");
const t4 = await autoSyncTickOnce("interval");
if (t4.terms.length !== 0)
  fail(`steady-state tick should probe only, re-synced ${JSON.stringify(t4.terms)}`);
ok("no section re-sync in steady state");
if (!t4.ok) fail(`steady tick not ok: ${t4.error}`);

console.log("lock: while another sync holds the lock, ticks are skipped");
fs.writeFileSync(path.join(TEST_DIR, "autosync.lock"), JSON.stringify({ pid: 99999, at: new Date().toISOString() }));
const t5 = await autoSyncTickOnce("interval");
if (!t5.skipped) fail(`expected skip under lock, got ${JSON.stringify(t5)}`);
ok(`skipped: ${t5.skipped}`);
fs.unlinkSync(path.join(TEST_DIR, "autosync.lock"));

console.log("loop: startAutoSync() runs a tick on its own, stopAutoSync() halts it");
const runsBefore = Number(meta("autosync_runs") ?? "0");
startAutoSync();
let runsAfter = runsBefore;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  runsAfter = Number(meta("autosync_runs") ?? "0");
  if (runsAfter > runsBefore) break;
}
stopAutoSync();
if (runsAfter <= runsBefore) fail(`background loop did not run a tick (runs ${runsBefore} → ${runsAfter})`);
ok(`loop tick landed (runs ${runsBefore} → ${runsAfter})`);
const st = getAutoSyncStatus();
if (!st.enabled) fail("status.enabled should be true");
if (st.lastOk !== true) fail(`status.lastOk = ${st.lastOk}`);
ok(`status: enabled, last ok, ${st.runs} runs, sections @ ${st.lastSectionsAt}`);

const logLines = fs.readFileSync(path.join(TEST_DIR, "autosync.log"), "utf8").trim().split("\n");
if (logLines.length < 5) fail("autosync.log too short");
ok(`autosync.log has ${logLines.length} JSON lines`);

mock.close();
console.log(`\nALL AUTOSYNC CHECKS PASSED (${passed} checks)`);
