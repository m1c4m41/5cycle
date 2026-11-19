/**
 * Keeping the catalog live without a resident process.
 *
 * Seats, perm counts, meeting times and locations change all day during
 * registration, but Vercel has no long-running timer (and the daily cron is
 * too coarse). So a page view that shows a term quietly re-checks it in the
 * background when the last check is older than a few minutes — the visitor is
 * served immediately from the database, and the refresh (a diff against the
 * live registrar feed that rewrites only what changed) lands moments later.
 *
 * Safe to expose: it takes no user input, only pulls from the public upstream
 * API, and a meta-row claim stops concurrent instances from piling on.
 */
import { after } from "next/server";
import { revalidateTag } from "next/cache";
import { CATALOG_TAG } from "./catalog";
import { all, get, getMeta, nowIso, setMeta } from "./db";
import { getAllTerms, termChronoKey } from "./hyperschedule";
import {
  ingestSections,
  refreshTerm,
  seasonalTermId,
  syncCourseAreas,
  syncTermListFrom,
  type RefreshReport,
} from "./ingest";
import { getSections } from "./hyperschedule";

/** How stale a term may get before a page view triggers a refresh. */
const MAX_AGE_MS = Number(process.env.CYCLE_REFRESH_SECONDS || 60) * 1000;
/** A claim older than this is assumed to belong to a crashed run. */
const CLAIM_MS = 3 * 60 * 1000;

const ageOf = (iso: string | undefined) => (iso ? Date.now() - Date.parse(iso) : Infinity);

/** Past terms are immutable; only the current and later terms change. */
function isLive(termId: string): boolean {
  return termChronoKey(termId) >= termChronoKey(seasonalTermId());
}

async function claim(key: string): Promise<boolean> {
  const held = await getMeta(`refreshing_${key}`);
  if (held && ageOf(held) < CLAIM_MS) return false;
  await setMeta(`refreshing_${key}`, nowIso());
  return true;
}

function bust() {
  try {
    revalidateTag(CATALOG_TAG);
  } catch {
    /* outside a request scope — the cache TTL catches up */
  }
}

/** Refresh one term now if it's live and stale. Never throws. */
export async function refreshTermIfStale(termId: string): Promise<RefreshReport | null> {
  try {
    if (!isLive(termId)) return null;
    if (ageOf(await getMeta(`checked_${termId}`)) < MAX_AGE_MS) return null;
    if (!(await claim(termId))) return null;
    const report = await refreshTerm(termId);
    await setMeta(`checked_${termId}`, nowIso());
    if (report.status === "patched" || report.status === "full") bust();
    return report;
  } catch (err) {
    console.warn(`[refresh] ${termId} failed:`, (err as Error).message);
    return null;
  }
}

/** Call from a page: serve now, refresh right after the response. */
export function refreshInBackground(termId: string): void {
  if (!termId) return;
  try {
    after(() => refreshTermIfStale(termId));
  } catch {
    /* not in a request scope (script / test) */
  }
}

/**
 * Cron entry (Vercel hits /api/sync): refresh the term list — which is how a
 * newly published term shows up — pull every new term in full, and diff-refresh
 * the live ones. New professors get their profile as part of the full ingest.
 */
export async function cronSync(): Promise<{ terms: string[]; reports: RefreshReport[] }> {
  if (!(await claim("cron"))) return { terms: [], reports: [] };
  const upstreamTerms = await getAllTerms(true);
  await syncTermListFrom(upstreamTerms);
  await syncCourseAreas(false);
  const known = new Set((await all<{ id: string }>("SELECT id FROM terms")).map((r) => r.id));
  const live = [...known].filter(isLive).sort((a, b) => termChronoKey(a) - termChronoKey(b));
  const reports: RefreshReport[] = [];
  for (const term of live) {
    const has = Number(
      (await get<{ n: number }>("SELECT COUNT(*) n FROM sections WHERE term_id = ?", [term]))?.n ?? 0,
    );
    try {
      if (has === 0) {
        // A term we've never loaded: pull it in full (empty/404 = not published yet).
        const sections = await getSections(term, true).catch(() => []);
        if (sections.length) {
          const r = await ingestSections(sections, term);
          reports.push({ term, status: "full", changed: r.sections, added: r.sections, removed: 0, ms: r.ms });
        }
      } else {
        reports.push(await refreshTerm(term));
      }
      await setMeta(`checked_${term}`, nowIso());
    } catch (err) {
      console.warn(`[cron] ${term} failed:`, (err as Error).message);
    }
  }
  if (reports.some((r) => r.status !== "unchanged" && r.status !== "skipped")) bust();
  return { terms: live, reports };
}
