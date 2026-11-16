/**
 * Auto-sync — keeps the local catalog current without anyone running
 * `npm run sync`.
 *
 * Where the data actually comes from
 * ----------------------------------
 * HyperSchedule (hyperschedule.io) is a student project for the Claremont
 * Colleges. The Consortium's registrar (Ellucian ICS) exposes internal
 * JSON endpoints (course-section, perm-count, course-section-schedule,
 * section-instructor, staff, calendar-session, …); the schools granted
 * HyperSchedule authenticated access to them, and a resident scheduler
 * process on their server polls each one on a timer — perm/section counts
 * every 60 s, meeting times every 30 min, staff/calendar hourly. When a
 * new term's schedule is officially live on the college portals, a
 * maintainer flips their CURRENT_TERM and that term appears on the public
 * v4 API at banana.hyperschedule.io within an hour. (See the open-source
 * repo github.com/hyperschedule/hyperschedule, branch v2,
 * backend/src/hmc-api/fetcher/ and shared/api/current-term.ts.)
 *
 * We don't have — and don't need — registrar credentials: the public v4
 * API is the tap. So this module just polls it:
 *
 *   1. Every CYCLE_AUTO_SYNC_MINUTES (default 60) it re-fetches
 *      /v4/term/all + /v4/term/current fresh (bypassing the file cache).
 *   2. A term id we've never seen is a newly published term → its catalog
 *      is pulled in immediately. Same for a moved current term.
 *   3. Every CYCLE_SECTION_SYNC_HOURS (default 4) the three newest terms
 *      are re-synced anyway, so seat counts, cancellations and
 *      mid-semester additions stay fresh.
 *   4. A listed term whose /v4/sections 404s (or arrives empty) is marked
 *      "pending" — the registrar hasn't loaded it yet — and retried on the
 *      next probe instead of counted as a failure.
 *
 * Concurrency: every run takes a file lock (data/autosync.lock), so a
 * manual `npm run sync`, a POST /api/sync, or the /admin buttons can never
 * run two catalog rewrites at once. SQLite (WAL + busy_timeout) covers the
 * rest. Status lands in meta (autosync_*) and data/autosync.log (JSON
 * lines, rotated at 2 MB).
 *
 * Enabled by default under `next start` (NODE_ENV=production). In
 * `next dev` it stays off unless CYCLE_AUTO_SYNC=1; CYCLE_AUTO_SYNC=0
 * disables it anywhere. Started once per process from instrumentation.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { all, getMeta, nowIso, setMeta } from "./db";
import { getAllTerms, termChronoKey, termIdOf } from "./hyperschedule";
import {
  bootstrap,
  seasonalTermId,
  syncTerm,
  syncTermListFrom,
  type SyncReport,
} from "./ingest";

const DATA_DIR =
  process.env.CYCLE_DATA_DIR || path.join(process.cwd(), "data");
const LOCK_PATH = path.join(DATA_DIR, "autosync.lock");
const LOG_PATH = path.join(DATA_DIR, "autosync.log");

const DEFAULT_PROBE_MINUTES = 60;
const DEFAULT_SECTION_HOURS = 4;
const DEFAULT_STARTUP_DELAY_MS = 15_000;
const STALE_LOCK_MS = 30 * 60 * 1000;
const LOG_MAX_BYTES = 2_000_000;

export type AutoSyncTermResult = {
  term: string;
  status: "synced" | "pending" | "failed";
  sections?: number;
  ms?: number;
  error?: string;
};

export type AutoSyncTickResult = {
  ok: boolean;
  reason: string;
  /** Set when the tick did no work (already running / lock held). */
  skipped?: string;
  newTerms: string[];
  currentChanged: boolean;
  terms: AutoSyncTermResult[];
  error?: string;
  ms: number;
};

/* ------------------------------- config -------------------------------- */

function probeMinutes(): number {
  const n = Number(process.env.CYCLE_AUTO_SYNC_MINUTES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_PROBE_MINUTES;
}

function sectionHours(): number {
  const n = Number(process.env.CYCLE_SECTION_SYNC_HOURS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SECTION_HOURS;
}

function startupDelayMs(): number {
  const n = Number(process.env.CYCLE_AUTO_SYNC_STARTUP_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STARTUP_DELAY_MS;
}

export function autoSyncEnabled(): boolean {
  const v = (process.env.CYCLE_AUTO_SYNC ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  return process.env.NODE_ENV === "production";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------- logging -------------------------------- */

function logEvent(event: string, extra: Record<string, unknown> = {}): void {
  const pretty = `[autosync] ${event}${
    Object.keys(extra).length ? " " + JSON.stringify(extra) : ""
  }`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + ".1");
    }
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: nowIso(), event, ...extra }) + "\n");
  } catch {
    /* logging must never break a sync */
  }
  if (event === "fail" || event === "loop-error" || event === "lock-error") {
    console.error(pretty);
  } else {
    console.log(pretty);
  }
}

/* -------------------------------- locking -------------------------------- */

export function acquireLock(): boolean {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        logEvent("lock-error", { error: errText(e) });
        return false;
      }
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue; // someone died on us; retry the open
        }
      } catch {
        continue; // lock vanished mid-race
      }
      return false;
    }
  }
  return false;
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

export function lockHolder(): string | null {
  try {
    return fs.readFileSync(LOCK_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/* ------------------------------ the tick -------------------------------- */

let busy = false;

export function autoSyncBusy(): boolean {
  return busy;
}

/**
 * One probe of upstream plus whatever section refresh is due. Safe to call
 * from the loop, from the admin "Sync now" path, or from tests.
 */
export async function autoSyncTickOnce(reason: string): Promise<AutoSyncTickResult> {
  if (busy) {
    logEvent("skip", { reason, why: "already running" });
    return skipResult(reason, "already running");
  }
  busy = true;
  if (!acquireLock()) {
    busy = false;
    logEvent("skip", { reason, why: "lock held by another sync" });
    return skipResult(reason, "lock held by another sync");
  }

  const t0 = Date.now();
  let res: AutoSyncTickResult;
  try {
    res = await runTick(reason, t0);
  } catch (e) {
    res = {
      ok: false,
      reason,
      newTerms: [],
      currentChanged: false,
      terms: [],
      error: errText(e),
      ms: Date.now() - t0,
    };
  }

  try {
    await setMeta("autosync_last_run", nowIso());
    await setMeta("autosync_last_ok", res.ok ? "1" : "0");
    await setMeta("autosync_last_reason", res.reason);
    await setMeta("autosync_last_error", res.error ?? res.skipped ?? "");
    await setMeta("autosync_last_report", JSON.stringify(res.terms));
    await setMeta("autosync_runs", String(Number((await getMeta("autosync_runs")) ?? "0") + 1));
  } catch {
    /* status persistence is best-effort */
  }

  busy = false;
  releaseLock();
  logEvent(res.skipped ? "skip" : res.ok ? "ok" : "fail", {
    reason,
    ms: res.ms,
    terms: res.terms.map((t) => `${t.term}:${t.status}`),
    newTerms: res.newTerms,
    currentChanged: res.currentChanged,
    error: res.error,
    skipped: res.skipped,
  });
  return res;
}

function skipResult(reason: string, why: string): AutoSyncTickResult {
  return {
    ok: false,
    reason,
    skipped: why,
    newTerms: [],
    currentChanged: false,
    terms: [],
    ms: 0,
  };
}

async function runTick(reason: string, t0: number): Promise<AutoSyncTickResult> {
  const out: AutoSyncTickResult = {
    ok: true,
    reason,
    newTerms: [],
    currentChanged: false,
    terms: [],
    ms: 0,
  };

  const priorTerms = new Set(
    (await all<{ id: string }>("SELECT id FROM terms")).map((r) => r.id),
  );
  const priorCurrent = (await getMeta("current_term")) ?? "";
  const priorReport = await lastReportFromMeta();
  const hadPending = priorReport.some((t) => t.status === "pending");

  // 1) Fresh term list from upstream — force=true bypasses the 1-day cache
  //    so a newly published term shows up within a single probe. The current
  //    term comes from the calendar season, not from upstream's "current"
  //    (which flips to Spring registration as soon as it opens, while Fall
  //    is still going).
  const upAll = await getAllTerms(true);
  const currentId = seasonalTermId();
  await syncTermListFrom(upAll);

  out.newTerms = upAll.map(termIdOf).filter((id) => !priorTerms.has(id));
  out.currentChanged = priorCurrent !== "" && priorCurrent !== currentId;

  const lastSections = await getMeta("autosync_last_sections");
  const sectionsStale =
    !lastSections ||
    Date.now() - new Date(lastSections).getTime() > sectionHours() * 3600_000;
  const due =
    reason === "manual" ||
    out.newTerms.length > 0 ||
    out.currentChanged ||
    hadPending ||
    sectionsStale;

  if (!due) {
    await setMeta("autosync_last_probe", nowIso());
    logEvent("probe", {
      current: currentId,
      newTerms: out.newTerms,
      currentChanged: out.currentChanged,
      due: false,
    });
    out.ms = Date.now() - t0;
    return out;
  }

  // 2) The newest three terms upstream, plus the current one if it somehow
  //    isn't among them: what students can register for now and plan for
  //    next. As new terms publish, the oldest drops off automatically.
  const newest = upAll
    .map(termIdOf)
    .sort((a, b) => termChronoKey(b) - termChronoKey(a))
    .slice(0, 3);
  const window = Array.from(new Set([currentId, ...newest]));

  for (const term of window) {
    try {
      const r: SyncReport = await syncTerm(term, true);
      out.terms.push({ term, status: "synced", sections: r.sections, ms: r.ms });
    } catch (e) {
      const msg = errText(e);
      // A term that's listed upstream but 404s (or arrives empty) for
      // sections hasn't been loaded into the registrar feed yet. That's
      // "pending", not a failure — the next probe retries it.
      const pending = /HTTP 404/.test(msg) || /returned 0 sections/.test(msg);
      out.terms.push({ term, status: pending ? "pending" : "failed", error: msg });
      if (!pending) out.ok = false;
    }
  }

  await setMeta("autosync_last_probe", nowIso());
  // If anything is still pending, don't stamp "sections fresh" — the next
  // probe must retry before the hour is up.
  if (!out.terms.some((t) => t.status === "pending")) {
    await setMeta("autosync_last_sections", nowIso());
  }
  out.ms = Date.now() - t0;
  return out;
}

/* ----------------------------- manual sync ------------------------------ */

/**
 * Locked manual sync — the single entry point for the /admin buttons,
 * POST /api/sync and `scripts/sync.mjs`-style one-offs. Takes the same lock
 * as the auto loop, so a click and a timer can never rewrite the catalog
 * at once.
 */
export async function manualSync(
  term?: string,
): Promise<{ reports?: SyncReport[]; current?: string; skipped?: string }> {
  if (!acquireLock()) {
    return { skipped: "A catalog sync is already running — try again in a minute." };
  }
  try {
    let reports: SyncReport[];
    let current: string | undefined;
    if (term) {
      reports = [await syncTerm(term, true)];
    } else {
      const boot = await bootstrap();
      reports = boot.reports;
      current = boot.current;
    }
    try {
      await setMeta("autosync_last_run", nowIso());
      await setMeta("autosync_last_ok", "1");
      await setMeta("autosync_last_error", "");
      await setMeta("autosync_last_reason", term ? "manual:" + term : "manual");
      await setMeta("autosync_last_sections", nowIso());
    } catch {
      /* best-effort */
    }
    logEvent("manual", { term: term ?? "bootstrap", reports: reports.length });
    return { reports, current };
  } finally {
    releaseLock();
  }
}

/* ------------------------------ lifecycle ------------------------------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/** Start the background loop. Idempotent per process; unref'd. */
export function startAutoSync(): void {
  if (!autoSyncEnabled()) {
    logEvent("disabled", { env: process.env.NODE_ENV ?? "" });
    return;
  }
  const g = globalThis as Record<string, unknown>;
  if (g.__cycleAutoSync) {
    logEvent("already-running", {});
    return;
  }
  g.__cycleAutoSync = true;
  stopped = false;
  logEvent("start", {
    probeMinutes: probeMinutes(),
    sectionHours: sectionHours(),
    pid: process.pid,
  });
  let first = true;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runLoopTick(first);
      first = false;
    }, ms);
    timer.unref?.();
  };
  const runLoopTick = async (isFirst: boolean) => {
    if (stopped) return;
    try {
      await autoSyncTickOnce(isFirst ? "startup" : "interval");
    } catch (e) {
      // autoSyncTickOnce catches its own errors; this is belt-and-braces so
      // the server process can never die from the sync loop.
      logEvent("loop-error", { error: errText(e) });
    }
    schedule(probeMinutes() * 60_000);
  };
  schedule(startupDelayMs());
}

export function stopAutoSync(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/* -------------------------------- status -------------------------------- */

export type AutoSyncStatus = {
  enabled: boolean;
  /** A tick is running in this process right now. */
  running: boolean;
  /** Contents of the lock file (pid/at) if another process holds it. */
  lock: string | null;
  probeMinutes: number;
  sectionHours: number;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastReason: string | null;
  lastError: string | null;
  lastSectionsAt: string | null;
  lastProbeAt: string | null;
  runs: number;
  lastReport: AutoSyncTermResult[];
};

async function lastReportFromMeta(): Promise<AutoSyncTermResult[]> {
  const raw = await getMeta("autosync_last_report");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AutoSyncTermResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getAutoSyncStatus(): Promise<AutoSyncStatus> {
  const okRaw = await getMeta("autosync_last_ok");
  return {
    enabled: autoSyncEnabled(),
    running: busy,
    lock: lockHolder(),
    probeMinutes: probeMinutes(),
    sectionHours: sectionHours(),
    lastRunAt: (await getMeta("autosync_last_run")) ?? null,
    lastOk: okRaw === undefined ? null : okRaw === "1",
    lastReason: (await getMeta("autosync_last_reason")) ?? null,
    lastError: (await getMeta("autosync_last_error")) || null,
    lastSectionsAt: (await getMeta("autosync_last_sections")) ?? null,
    lastProbeAt: (await getMeta("autosync_last_probe")) ?? null,
    runs: Number((await getMeta("autosync_runs")) ?? "0"),
    lastReport: await lastReportFromMeta(),
  };
}
