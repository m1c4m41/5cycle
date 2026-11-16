import Link from "next/link";
import { redirect } from "next/navigation";
import {
  importRmpAction,
  reloadRequirementsAction,
  syncAreasAction,
  syncCatalogAction,
} from "@/actions/admin";
import { getAutoSyncStatus } from "@/lib/autosync";
import { SCHOOLS } from "@/lib/constants";
import { all } from "@/lib/db";
import { PERM_TEMPLATES } from "@/lib/perm";
import { adminSnapshot } from "@/lib/read";
import { currentUser } from "@/lib/session";
import { isUnauthorized, type ActionState } from "@/lib/server";
import { schoolShort } from "@/lib/util";

/**
 * Operator console: catalog sync, data health, requirement reloads, RMP mirror
 * and the perm-destination table.
 *
 * Everything here is a server-rendered `<form>` posting to a Server Action in
 * actions/admin.ts — no fetch(), no client component, no bundle. Note that
 * Server Action forms DO require JavaScript in the browser (unlike the
 * catalog's plain GET form): with JS off the buttons do nothing.
 *
 * The actions in that file were written for `useActionState`, i.e. they take
 * `(prevState, formData)`; a plain form passes FormData as the *first*
 * argument, so each one is wrapped in an inline server action below that calls
 * it with `null` state and bounces the resulting notice/error back into the
 * query string (the same trick actions/form.ts uses).
 */
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

const FIVE_C = SCHOOLS.filter((s) => s.code !== "CG");

/** The five campuses an undergraduate holds a perm form at, in strip order. */
const PERM_CODES = ["CM", "HM", "PZ", "PO", "SC"] as const;

const KIND_LABELS: Record<string, string> = {
  ge: "Campus GE / general requirements",
  major: "Majors",
  minor: "Minors",
};

/**
 * actions/admin.ts gates every action fail-closed on CYCLE_ADMIN_TOKEN
 * (isAdminToken in lib/server.ts): signed in AND correct token, or the action
 * is denied. Read at request time (this page is never static).
 */
function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}

/** ISO timestamp → "2026-11-14 07:31:24Z"; UTC so the render is deterministic. */
function fmtUtc(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().replace("T", " ").slice(0, 19)}Z`;
}

type Act = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** Run a (prev, fd) action, then return to /admin with the outcome in the URL. */
async function run(action: Act, fd: FormData): Promise<void> {
  let res: ActionState = null;
  let failure = "";
  let signedOut = false;
  try {
    res = await action(null, fd);
  } catch (err) {
    signedOut = isUnauthorized(err);
    failure = err instanceof Error ? err.message : "Unknown error while running the action.";
  }
  // Every action in actions/admin.ts calls requireUser() first.
  if (signedOut) redirect("/login?next=%2Fadmin");

  const q = new URLSearchParams();
  if (failure) q.set("err", failure);
  else if (res?.ok) q.set("ok", res.notice ?? "Done.");
  else q.set("err", res?.error ?? "The action returned no result.");
  redirect(`/admin?${q.toString()}`);
}

function TokenField() {
  return (
    <div className="sm:max-w-48">
      <label className="label">Admin token</label>
      <input
        name="token"
        type="password"
        className="input"
        autoComplete="off"
        placeholder="CYCLE_ADMIN_TOKEN"
      />
    </div>
  );
}

function Tile({
  n,
  label,
  zeroWarn = true,
}: {
  n: number;
  label: string;
  zeroWarn?: boolean;
}) {
  const zero = zeroWarn && n === 0;
  return (
    <div
      className={`rounded-lg border p-3 ${
        zero ? "border-amber-300 bg-amber-50" : "border-ink-200 bg-ink-50"
      }`}
    >
      <p className="text-xl font-bold leading-none text-ink-900">{n.toLocaleString()}</p>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      {zero && (
        <p className="mt-1">
          <span className="chip border-amber-300 bg-white text-amber-800">zero — check sync</span>
        </p>
      )}
    </div>
  );
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const err = one(sp.err);
  const ok = one(sp.ok);

  const user = await currentUser();
  // The console is for the operator: unauthenticated visitors are bounced to
  // login. (Signed-in students still cannot act — every form requires the
  // admin token, checked fail-closed in actions/admin.ts.)
  if (!user) redirect("/login?next=%2Fadmin");
  const snap = await adminSnapshot();
  const stats = snap.stats;

  /* ---- inline server actions (allowed in Server Components) ---- */
  async function syncAllTerms(fd: FormData) {
    "use server";
    await run(syncCatalogAction, fd);
  }
  async function syncOneTerm(fd: FormData) {
    "use server";
    await run(syncCatalogAction, fd);
  }
  async function refreshAreas(fd: FormData) {
    "use server";
    await run(syncAreasAction, fd);
  }
  async function reloadRequirements(fd: FormData) {
    "use server";
    await run(reloadRequirementsAction, fd);
  }
  async function importRmp(fd: FormData) {
    "use server";
    await run(importRmpAction, fd);
  }

  /* ------------------------------- queries ------------------------------- */
  const terms = await all<{ id: string; label: string; is_current: number; synced_at: string | null; n: number }>(
    `SELECT t.id, t.label, t.is_current, t.synced_at,
            (SELECT COUNT(*) FROM sections s WHERE s.term_id = t.id) AS n
     FROM terms t
     ORDER BY n DESC, t.id DESC`,
  );
  const populated = terms.filter((t) => Number(t.n) > 0);
  const emptyTermCount = terms.length - populated.length;

  const reqRows = await all<{
    id: string;
    school: string;
    kind: string;
    name: string;
    verified: number;
    source: string | null;
  }>(
    `SELECT id, school, kind, name, verified, source
     FROM requirement_sets
     ORDER BY kind, school, name`,
  );
  const kinds = ["ge", "major", "minor"] as const;
  const groups = kinds.map((kind) => {
    const rows = reqRows.filter((r) => r.kind === kind);
    return {
      kind,
      label: KIND_LABELS[kind] ?? kind,
      rows,
      unverified: rows.filter((r) => Number(r.verified) === 0).length,
    };
  });
  const unverified = Number(snap.unverifiedSets);
  const totalSets = Number(snap.requirementSets);

  const permRows = PERM_CODES.map((code) => ({ code, tpl: PERM_TEMPLATES[code] }));
  const unverifiedPerms = permRows.filter((r) => r.tpl.verified === false).length;

  const sectionsBySchool = new Map(stats.bySchool.map((r) => [r.school, Number(r.n)]));
  const rmpCached = Number(snap.rmpCached);
  const instructors = Number(stats.instructors);
  const autoSync = await getAutoSyncStatus();

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Operator console</h1>
        <p className="max-w-3xl text-sm text-ink-600">
          Sync the course catalog, reload requirement definitions and inspect data health —
          all of it from plain forms, no build step required.
        </p>
      </header>

      {/* ------------------------------ banner ------------------------------ */}
      <section className="card card-pad space-y-2 border-emerald-300 bg-emerald-50/70">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip border-emerald-300 bg-white text-emerald-800">Admin only</span>
          <span className="text-sm font-semibold text-ink-900">
            Every form below requires the admin token — signed in as{" "}
            <strong>{user.name}</strong>, token checked fail-closed.
          </span>
        </div>
      </section>

      {err && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </p>
      )}
      {ok && (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {ok}
        </p>
      )}

      {/* --------------------------- 1. catalog sync ------------------------- */}
      <section className="card card-pad space-y-4">
        <div>
          <h2 className="text-sm font-bold text-ink-900">1 · Catalog sync</h2>
          <p className="mt-1 text-sm text-ink-600">
            Each button pulls the live registrar course feed and rewrites the local catalog. These are
            Server Action forms, so they need JavaScript in the browser; unlike the catalog&apos;s
            filter form, they do nothing without it.
          </p>
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            How a term sync behaves: <span className="kbd">ingestSections()</span> upserts every
            section <em>in place</em> inside one transaction — seat counts, times and instructors are
            updated on the existing rows, and only sections upstream stopped offering are deleted.
            Re-running a term is idempotent and can never wipe a student&apos;s saved plan: an
            in-place <span className="kbd">ON CONFLICT DO UPDATE</span> leaves the section row (and
            therefore its enrollments) alone. If a sync starts failing after accounts exist, check{" "}
            <span className="kbd">data/autosync.log</span> first.
          </p>

          {/* auto-sync status */}
          <div className="rounded-lg border border-ink-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Auto-sync
              </span>
              {autoSync.enabled ? (
                <span className="chip border-emerald-300 bg-emerald-50 text-emerald-800">
                  on — probes upstream every {autoSync.probeMinutes} min · re-syncs terms every{" "}
                  {autoSync.sectionHours} h
                </span>
              ) : (
                <span className="chip border-amber-300 bg-amber-50 text-amber-800">
                  off here — on by default under <span className="kbd">next start</span>; set{" "}
                  <span className="kbd">CYCLE_AUTO_SYNC=1</span> in dev
                </span>
              )}
              {autoSync.running && (
                <span className="chip border-blue-300 bg-blue-50 text-blue-800">syncing now…</span>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-600">
              A new term is pulled in automatically the moment it appears on the registrar&rsquo;s
              feed. Last run {fmtUtc(autoSync.lastRunAt)} —{" "}
              {autoSync.lastOk === null ? "never" : autoSync.lastOk ? "ok" : "error"}
              {autoSync.lastError ? ` (${autoSync.lastError})` : ""} · sections last refreshed{" "}
              {fmtUtc(autoSync.lastSectionsAt)} · {autoSync.runs} run(s) total.
              {autoSync.lastReport.length > 0 && (
                <>
                  {" "}
                  Last:{" "}
                  {autoSync.lastReport
                    .map((t) =>
                      `${t.term} ${t.status}${
                        t.sections != null ? ` (${t.sections})` : ""
                      }${
                        t.status === "pending"
                          ? " — not published upstream yet, retrying"
                          : t.status === "failed"
                            ? ` — ${t.error ?? ""}`
                            : ""
                      }`,
                    )
                    .join(", ")}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <form action={syncAllTerms} className="flex flex-col gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Sync current + upcoming terms
            </p>
            <p className="text-xs text-ink-600">
              Re-reads the term list, then the current term plus the newest listed terms and the most
              recent past term. Sends an empty <span className="kbd">term</span> field, which is what
              tells the action to bootstrap rather than sync one term.
            </p>
            <TokenField />
            <button type="submit" className="btn-primary self-start">
              Sync terms
            </button>
          </form>

          <form action={syncOneTerm} className="flex flex-col gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Sync one term
            </p>
            <p className="text-xs text-ink-600">
              Force-refresh a single term — useful when only Spring registration has moved. Field
              name is <span className="kbd">term</span>, format <span className="kbd">FA2026</span>.
            </p>
            <div>
              <label className="label" htmlFor="term">
                Term id
              </label>
              <input
                id="term"
                name="term"
                className="input font-mono text-xs"
                placeholder="FA2026"
                list="term-ids"
                autoComplete="off"
              />
              <datalist id="term-ids">
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </datalist>
            </div>
            <TokenField />
            <button type="submit" className="btn-secondary self-start">
              Sync this term
            </button>
          </form>

          <div className="flex flex-col gap-3">
            <form action={refreshAreas} className="flex flex-col gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Refresh course-area definitions
              </p>
              <p className="text-xs text-ink-600">
                Re-pulls the registrar course-area designations that drive GE matching (
                {stats.areas.toLocaleString()} areas on file).
              </p>
              <TokenField />
              <button type="submit" className="btn-secondary self-start">
                Refresh areas
              </button>
            </form>

            <form action={reloadRequirements} className="flex flex-col gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Reload requirement definitions
              </p>
              <p className="text-xs text-ink-600">
                Re-reads <span className="kbd">data/requirements/*.json</span> into{" "}
                <span className="kbd">requirement_sets</span>. Run this after hand-editing those
                files; it does not touch the catalog.
              </p>
              <TokenField />
              <button type="submit" className="btn-secondary self-start">
                Reload requirements
              </button>
            </form>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-ink-700">
            Last bulk sync (<span className="kbd">meta.terms_synced_at</span>):{" "}
            <strong className="font-mono text-xs">{fmtUtc(snap.lastSync)}</strong>
            {snap.lastSync
              ? ` · ${new Date(snap.lastSync).getTime() < Date.now() - 24 * 3600 * 1000 ? "older than a day — re-sync before relying on seat counts." : "fresh."}`
              : " · nothing has been synced from this page yet."}
          </p>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-160 border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="py-1.5 pr-3 font-semibold">Term</th>
                  <th className="py-1.5 pr-3 font-semibold">Label</th>
                  <th className="py-1.5 pr-3 font-semibold">Current</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Sections</th>
                  <th className="py-1.5 font-semibold">synced_at</th>
                </tr>
              </thead>
              <tbody>
                {populated.length === 0 && (
                  <tr className="border-b border-ink-100">
                    <td colSpan={5} className="py-3 text-sm text-ink-500">
                      No term has any sections yet. Use “Sync terms” above.
                    </td>
                  </tr>
                )}
                {populated.map((t) => (
                  <tr key={t.id} className="border-b border-ink-100">
                    <td className="py-1.5 pr-3 font-mono text-xs">{t.id}</td>
                    <td className="py-1.5 pr-3">{t.label}</td>
                    <td className="py-1.5 pr-3">
                      {Number(t.is_current) === 1 ? (
                        <span className="chip border-brand-300 bg-white text-brand-700">current</span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-xs">{Number(t.n).toLocaleString()}</td>
                    <td className="py-1.5 font-mono text-xs text-ink-500">
                      {fmtUtc(t.synced_at)}
                      {t.synced_at ? "" : " (row exists, never fetched)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-500">
            The <span className="kbd">terms</span> table carries {terms.length.toLocaleString()} rows
            because the term list spans a decade of history; {emptyTermCount.toLocaleString()} of
            them have zero sections and are listed nowhere above.
          </p>
        </div>
      </section>

      {/* -------------------------- 2. catalog health ------------------------ */}
      <section className="card card-pad space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-ink-900">2 · Catalog health</h2>
          <span className="chip border-amber-300 bg-amber-50 text-amber-800">
            amber = a count of zero
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Tile n={stats.sections} label="sections" />
          <Tile n={stats.courses} label="distinct courses" />
          <Tile n={stats.instructors} label="instructors" />
          <Tile n={stats.areas} label="course areas" />
          <Tile n={stats.reviews} label={stats.reviews === 1 ? "native review" : "native reviews"} />
          <Tile n={stats.users} label={stats.users === 1 ? "user account" : "user accounts"} />
        </div>
        <p className="text-sm leading-relaxed text-ink-700">
          {stats.sections.toLocaleString()} sections are mirrored right now, spread over{" "}
          {populated.length} term
          {populated.length === 1 ? "" : "s"}: {populated.map((t) => t.id).join(", ") || "none"}.
          The reference shape this console was written against is <strong>8,959 sections across
          FA2026 / SP2027 / SP2026 / SP2025</strong>; if the live count drops to zero or a term
          disappears, suspect the sync before suspecting the importer.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {FIVE_C.map((s) => (
            <span key={s.code} className="chip border-ink-300 bg-white text-ink-700">
              {s.short} {Number(sectionsBySchool.get(s.code) ?? 0).toLocaleString()}
              {(sectionsBySchool.get(s.code) ?? 0) === 0 && " · none"}
            </span>
          ))}
          {Number(sectionsBySchool.get("CG") ?? 0) > 0 && (
            <span className="chip border-ink-200 bg-ink-50 text-ink-500">
              CGU {Number(sectionsBySchool.get("CG")).toLocaleString()} (grad, out of scope)
            </span>
          )}
        </div>
        <p className="text-xs text-ink-500">
          Fields above come from <span className="kbd">catalogStats()</span> in lib/ingest.ts —
          sections, distinct <span className="kbd">course_code</span>, instructors, course_areas,
          reviews, users and per-school section counts. Everything else in this section is a direct
          query against <span className="kbd">terms</span> / <span className="kbd">sections</span>.
          A zero here means the data is missing locally, not that the campus has nothing to offer.
        </p>
      </section>

      {/* ----------------------- 3. requirements quality --------------------- */}
      <section className="card card-pad space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-ink-900">3 · Requirements data quality</h2>
            <p className="mt-1 text-sm text-ink-600">
              {totalSets.toLocaleString()} requirement sets in the database. The{" "}
              <span className="kbd">verified</span> flag is a manual claim: nothing sets it
              automatically.
            </p>
          </div>
          <span
            className={`chip ${
              unverified > 0
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-800"
            }`}
          >
            {unverified.toLocaleString()} of {totalSets.toLocaleString()} unverified
          </span>
        </div>

        <p className="rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm leading-relaxed text-ink-700">
          The source of truth is <span className="kbd">data/requirements/ge.json</span> and{" "}
          <span className="kbd">data/requirements/majors.json</span>, not these tables. Edit the JSON
          by hand, press <em>Reload requirement definitions</em> above, and the sets, groups and
          matchers are rebuilt. Until a human has compared a set against the relevant campus catalog,
          it should stay <span className="kbd">verified: false</span> and be treated as an advisory guess.
        </p>

        {groups.map((g) => (
          <div key={g.kind} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-500">{g.label}</h3>
              <span className="chip border-ink-200 bg-white text-ink-600">{g.rows.length}</span>
              {g.unverified > 0 && (
                <span className="chip border-amber-300 bg-amber-50 text-amber-900">
                  {g.unverified} unverified
                </span>
              )}
              {g.rows.length === 0 && (
                <span className="chip border-red-300 bg-red-50 text-red-800">
                  none loaded — reload from JSON
                </span>
              )}
            </div>
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-160 border-collapse text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="py-1.5 pr-3 font-semibold">Set id</th>
                    <th className="py-1.5 pr-3 font-semibold">Campus</th>
                    <th className="py-1.5 pr-3 font-semibold">Name</th>
                    <th className="py-1.5 font-semibold">Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.id} className="border-b border-ink-100 align-top">
                      <td className="py-1.5 pr-3 font-mono text-xs text-ink-600">{r.id}</td>
                      <td className="py-1.5 pr-3 text-xs">{schoolShort(r.school)}</td>
                      <td className="py-1.5 pr-3">
                        {r.name}
                        {r.source && (
                          <span className="block text-[11px] text-ink-400">source: {r.source}</span>
                        )}
                      </td>
                      <td className="py-1.5">
                        {Number(r.verified) === 1 ? (
                          <span className="chip border-emerald-300 bg-emerald-50 text-emerald-800">
                            verified
                          </span>
                        ) : (
                          <span className="chip border-amber-300 bg-amber-50 text-amber-900">
                            not verified
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      {/* --------------------------- 4. RMP mirror --------------------------- */}
      <section className="card card-pad space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-ink-900">4 · RateMyProfessors data</h2>
          <span
            className={`chip ${
              rmpCached === 0
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-ink-300 bg-white text-ink-600"
            }`}
          >
            {rmpCached.toLocaleString()} of {instructors.toLocaleString()} professors have a cached
            score
          </span>
        </div>
        <p className="text-sm leading-relaxed text-ink-700">
          RateMyProfessors publishes <strong>no public API</strong> and automated access is against
          its terms, so 5Cycle does not scrape it — the live mirror was removed for public use. The
          supported path is the manual import below (hand-curated{" "}
          <span className="kbd">data/rmp-manual.json</span>, no network), plus the search links the
          professor pages already generate for anyone without a cached score.
        </p>
        <form
          action={importRmp}
          className="flex max-w-md flex-col gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Import data/rmp-manual.json
          </p>
          <p className="text-xs text-ink-600">
            No network, no ToS exposure: reads the hand-curated JSON and attaches scores to
            instructors matched by normalized name. Reports any names it could not match.
          </p>
          <TokenField />
          <button type="submit" className="btn-primary self-start">
            Import manual RMP data
          </button>
        </form>
        <p className="text-xs text-ink-500">
          Professors without an imported score stay NULL — the pages link out to an RMP search
          rather than showing a stale or fabricated number.
        </p>
      </section>

      {/* ------------------------- 5. perm destinations ---------------------- */}
      <section className="card card-pad space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-ink-900">5 · Perm form destinations</h2>
          {unverifiedPerms > 0 ? (
            <span className="chip border-red-300 bg-red-50 text-red-800">
              {unverifiedPerms} of {PERM_CODES.length} not yet verified
            </span>
          ) : (
            <span className="chip border-emerald-300 bg-emerald-50 text-emerald-800">
              all verified
            </span>
          )}
        </div>
        <p className="text-sm text-ink-600">
          These are the targets <span className="kbd">lib/perm.ts</span> offers per home campus,
          editable there without touching the UI (or overridden at runtime with{" "}
          <span className="kbd">CYCLE_PERM_LINKS_JSON</span>). Walk each one while logged in as a
          student and replace it with the actual perm form URL when you find it.
        </p>
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-192 border-collapse text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="py-1.5 pr-3 font-semibold">Campus</th>
                <th className="py-1.5 pr-3 font-semibold">Button label</th>
                <th className="py-1.5 pr-3 font-semibold">Destination</th>
                <th className="py-1.5 pr-3 font-semibold">Help text shown to students</th>
                <th className="py-1.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {permRows.map(({ code, tpl }) => (
                <tr key={code} className="border-b border-ink-100 align-top">
                  <td className="py-2 pr-3 font-semibold">{schoolShort(code)}</td>
                  <td className="py-2 pr-3 text-xs">{tpl.label}</td>
                  <td className="py-2 pr-3">
                    <a
                      className="link break-all font-mono text-xs"
                      href={tpl.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {tpl.url}
                    </a>
                  </td>
                  <td className="py-2 pr-3 text-xs leading-relaxed text-ink-600">{tpl.help}</td>
                  <td className="py-2">
                    {tpl.verified ? (
                      <span className="chip border-emerald-300 bg-emerald-50 text-emerald-800">
                        verified
                      </span>
                    ) : (
                      <span className="chip border-red-300 bg-red-50 text-red-800">
                        not yet verified
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm leading-relaxed text-ink-700">
          A truly pre-filled deep link is not possible: the perm forms live behind campus SSO, so we
          cannot render one for a student who has not authenticated there. That is why every section
          page pairs the destination button with two artefacts generated from the mirrored row — an
          instructor-consent <span className="kbd">mailto:</span> with the course already written out,
          and a paste-ready block (term, code, section, instructor, credits on both scales, meeting
          times, listed perm seats, status). Students copy those into the real form.
        </p>
      </section>

      <p className="text-xs text-ink-500">
        Nothing on this page is saved to a database other than the catalog, area, requirement and
        instructor tables the actions own.{" "}
        <Link href="/catalog" className="link">
          Back to the catalog →
        </Link>
      </p>
    </div>
  );
}
