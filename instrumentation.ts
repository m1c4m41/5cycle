/**
 * Process-level bootstrap for the Node server runtime.
 *
 * Next calls register() exactly once per server process, before it handles
 * requests. This is where the catalog auto-sync loop (lib/autosync.ts) is
 * started — the edge runtime never loads it, and in `next dev` it stays off
 * unless CYCLE_AUTO_SYNC=1 is set (see lib/autosync.ts for the full model
 * and the upstream data story).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Serverless hosts (Vercel) have no long-lived process: a per-instance timer
  // loop would restart on every cold invocation, and its DB writes live in an
  // ephemeral /tmp. There, catalog refreshes come from the Vercel cron on
  // /api/sync instead (see vercel.json).
  if (process.env.VERCEL) return;
  // register() also runs during `next build`; never start the loop then.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startAutoSync } = await import("./lib/autosync");
  startAutoSync();
}
