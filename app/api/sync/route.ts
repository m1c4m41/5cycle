import crypto from "node:crypto";
import { catalogStats } from "@/lib/ingest";
import { getAutoSyncStatus, manualSync } from "@/lib/autosync";
import { loadRequirementFiles as loadReq } from "@/lib/requirements";
import { isAdminToken } from "@/lib/server";
import { jsonResponse } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pull the live 5C catalog into SQLite.
 *
 *   POST  {"term": "SP2027"}  — force one term
 *   POST  (no body)           — bootstrap: term list + current + next terms
 *   GET                       — catalog stats + auto-sync status
 *
 * Every run takes the same file lock the background auto-sync uses
 * (lib/autosync.ts), so a manual hit and the timer never overlap.
 *
 * Auth is fail-closed: a CYCLE_ADMIN_TOKEN in the environment is required,
 * presented as `x-admin-token` or `Authorization: Bearer <token>`. If no
 * admin token is configured, the CYCLE_CRON_SECRET (set for the Vercel
 * hourly cron) is accepted instead. With neither configured every request
 * is rejected.
 */
function authorized(req: Request): boolean {
  const direct = req.headers.get("x-admin-token");
  const bearer = req.headers.get("authorization")?.startsWith("Bearer ")
    ? req.headers.get("authorization")!.slice(7)
    : null;
  const token = direct ?? bearer ?? "";
  if (isAdminToken(token)) return true;
  // Vercel cron (vercel.json) calls this route hourly; it presents the
  // project's cron secret, which we accept if CYCLE_CRON_SECRET is set.
  const cron = process.env.CYCLE_CRON_SECRET;
  if (cron && token.length === cron.length) {
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cron));
    } catch {
      return false;
    }
  }
  return false;
}

export async function POST(req: Request) {
  if (!(await authorized(req))) return jsonResponse({ error: "bad admin token" }, { status: 401 });

  let term: string | undefined;
  try {
    const body = (await req.json()) as { term?: string };
    term = body?.term;
  } catch {
    /* no body */
  }

  const started = Date.now();
  const { reports, current, skipped } = await manualSync(term);
  if (skipped) return jsonResponse({ ok: false, error: skipped }, { status: 503 });
  const requirements = await loadReq();

  return jsonResponse({
    ok: true,
    ms: Date.now() - started,
    current,
    reports,
    requirements,
    stats: await catalogStats(),
  });
}

export async function GET(req: Request) {
  if (!(await authorized(req))) return jsonResponse({ error: "bad admin token" }, { status: 401 });
  return jsonResponse({ ok: true, stats: await catalogStats(), autoSync: await getAutoSyncStatus() });
}
