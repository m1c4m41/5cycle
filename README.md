# 5Cycle — 5C Academic Planner

A HyperSchedule replacement for the Claremont Colleges that adds a personal
planner: accounts, major/minor/GE checklists that tick themselves as you build a
schedule, a weekly timetable, cross-registration registrar portal buttons, and
professor ratings.

Course data comes from HyperSchedule's real public API (`https://banana.hyperschedule.io/v4/`).

## Run it

```bash
npm install
npm run sync                 # pull the current + upcoming terms into data/db.sqlite
npm run dev                  # http://localhost:3000
```

`npm run sync` is only for first-time setup or a forced catch-up. Under
`next start` the server runs a background auto-sync loop (see
[Auto-updating catalog](#auto-updating-catalog)) that picks up new terms and
keeps seat counts fresh on its own — no cron, no mirroring, no registrar
credentials.

You can browse the catalog, section pages, and planner without an account. When a
guest clicks **Add to plan**, they're sent to sign in (or create an account) with the
course they chose carried along — the moment they're signed in, that class is added
to their new plan automatically.

Test account used by the verify/smoke scripts: `qa@5cycle.app` / `qa-claremont5`.

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run sync -- SP2027` | sync one term |
| `npm run sync -- --areas` | refresh course-area definitions |
| `npm run build` / `start` | production build + serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | planner/requirement logic against the real catalog |
| `npm run smoke` | HTTP smoke: auth, page content, a real mutation |
| `npm run autosync-check` | hermetic auto-sync regression (mock v4 API, DB snapshot) |
| `npm run render-check` | CDP browser: styles + interactive render checks |
| `npm run guest-flow` | CDP browser: guest add → login/signup → plan complete |
| `npm test` | typecheck + verify + smoke |
| `npm run reset` | delete the local database |

## Auto-updating catalog

Where the data comes from: HyperSchedule (a student project for the 5C)
holds authenticated access to the consortium registrar's internal Ellucian
ICS JSON endpoints and polls them on resident timers — perm/section counts
every minute, meeting times every 30 min, staff/calendar hourly. When a new
term's data is live on the college portals, a maintainer flips their
`CURRENT_TERM` and that term appears on the public v4 API within an hour.
5Cycle just polls that public API; it needs no credentials of its own.

Under `next start`, `instrumentation.ts` starts a background loop
(`lib/autosync.ts`):

- **Probes** `/v4/term/all` + `/v4/term/current` fresh every
  `CYCLE_AUTO_SYNC_MINUTES` (default 60 min, cache bypassed).
- **New term detected** — an id not yet in the DB — is ingested
  immediately; same for a moved current term.
- **Refresh cadence** — every `CYCLE_SECTION_SYNC_HOURS` (default 4 h) the
  three newest terms are re-synced, so seat counts, cancellations and
  late-added sections stay fresh through registration.
- **Pending, not failed** — a term that's listed upstream but whose
  `/v4/sections` 404s (registrar hasn't loaded it yet) is marked pending
  and retried on the next probe.
- **Locked** — every run (background loop, `POST /api/sync`, the /admin
  buttons, `npm run sync`) takes the same file lock
  (`data/autosync.lock`), so two catalog rewrites can never race.
- **Observable** — status in `meta` (`autosync_*` keys) plus a JSON-lines
  log at `data/autosync.log`; the /admin page has a live status card and
  `GET /api/sync` returns the same as JSON.
- **Plan-safe** — re-syncs upsert sections in place and delete only what
  vanished upstream, so saved plans survive (see the trap below).

Enabled by default in production, off under `next dev` unless
`CYCLE_AUTO_SYNC=1`; `CYCLE_AUTO_SYNC=0` disables it anywhere. Other knobs:
`CYCLE_AUTO_SYNC_STARTUP_DELAY_MS` (default 15 s) and `HYPERSCHEDULE_API`
(base-URL override — the regression test points it at a local mock).

## Stack

Next.js 15 App Router, React 19, Tailwind v4, TypeScript. No external database —
Node's built-in `node:sqlite`, file at `data/db.sqlite`. Auth is signed session
cookies over scrypt-hashed passwords. All writes are Server Actions (forms work
with JavaScript disabled); `/api/*` exists for scripted use only.

Requirement definitions are editable JSON in `data/requirements/*.json`, loaded
into SQLite by `loadRequirementFiles()`. The engine assigns courses to
requirement boxes two ways:

- **Automatic** — maximum bipartite matching (Kuhn's algorithm) fills each set
  with the best available courses, so a course isn't used twice *inside* one
  set unless the set's rules allow it.
- **Manual (counting boxes)** — you check any number of boxes per course and
  those pins are honored exactly. A single course may tick boxes in several sets
  at once (major + minor + GE), and Educational-Objective / Breadth-of-Knowledge
  boxes may *double-dip* a course that already counts elsewhere in the same set.

**Half-credit rule:** a 0.5-credit course can't tick a GE or Breadth box (a full
credit is required at most 5C schools), but its credits still count toward the
32-credit graduation total. **Manual courses** — study-abroad classes, transfer
credit, or "create your own" — are entered by hand (title, credits, type) and
can be checked against any requirement boxes; a per-term "studying abroad"
checkbox plus free-text term labels cover programs (e.g. summer abroad) that
have no catalog term.

## What's verified working

- Catalog sync: 17,695 sections / 1,519 professors across eight terms
  (SP2024–SP2027, FA2023–FA2026); auto-sync picks up a new term the moment
  it appears upstream (verified with the FA2027/SU2028 injection test).
- Search + filters by term, campus, department, course area.
- Planner: add / remove / force-add past a time conflict, status changes, weekly timetable.
- Checklist: ticks a group when a matching course is added, unticks when removed, deterministic.
- Credits: HMC's 3-credit scale normalized to the 5C ~1.0 scale so totals compare.
- Re-syncing a term preserves saved plans (see the `INSERT OR REPLACE` trap below).
- Professor directory + detail pages, native star reviews (posted anonymously,
  one per account, editable/deletable by the author; stars link to the reviews).
- Double majoring: a second major at signup or in the profile, tracked as its
  own checklist alongside the major, minor and GE.
- Advisor-designated counting: pin any course to any requirement box(es); the
  manual pins override the automatic matcher and are listed in the
  "Counting boxes — advisor designations" panel on the requirements page.
- Catalog search: one shared term dropdown; fuzzy/buzzword matching
  (`chem` → lectures and labs); dept+number in one or two tokens
  (`dance 152`, `math58`, `chem 014L`) with prefix-aware department matching
  and ±100 course-number fuzz; working Next/Previous pagination.
- Catalog → planner: each result shows section number, a schedule-fit chip
  (fits / overlaps your existing grid) and a "View on grid" preview; a sticky
  "Your <term> grid" sidebar renders your weekly timetable live beside results.
- Term switching: the term dropdown on the catalog and planner auto-submits the
  moment you pick a term, so the results, the fit chips, and the weekly grid
  all switch to that term's saved classes instantly (a submit button keeps it
  working with JavaScript disabled).
- Collapsed checklist: on /requirements the major / minor / GE set cards open
  collapsed by default (name, progress bar and credit line stay visible in the
  header); the quick-jump chips in the progress summary expand just the card
  you click.
- Planner: per-term "studying abroad" checkbox, and hand-entered courses
  (study abroad / transfer credit / create-your-own) with title, credits, type
  and multi-checkbox requirement assignment; they appear in the weekly grid
  (unscheduled list) and count toward term totals.
- Checklist: full-plan view across all terms; 0.5-credit courses can't tick a
  GE or Breadth box (flagged, full credit required) but still count toward the
  32-credit graduation total; educational-objective / breadth boxes may
  double-dip; one course can tick major + minor + GE simultaneously.
- All pages render with zero server-side errors, authenticated and anonymous.

## Known limits — read before trusting it

1. **Requirement data is unverified.** All 342 requirement sets (majors, minors
   and GE) are drafted against each school's official catalogue program pages
   (Coursedog / Modern Campus, 2023-24 through 2026-27 editions) and carry
   `verified: false` in the database. Rules encode the standard path only — they
   cannot see waivers, overrides, AP/IB credit or catalog-year changes. Treat a
   green checklist as a draft, then confirm with your department. Fixing this
   means editing `data/requirements/*.json` against the live catalogues.
2. **Perm forms are not deep-linked.** The registrar forms sit behind campus
   SSO, so nothing external can pre-fill them. For a cross-campus section,
   5Cycle opens your home campus registrar portal in a new tab (a landing page —
   the perm form is a click or two further in).
3. **RateMyProfessors is mirrored, not licensed.** RMP has no public API and its
   terms of service forbid scraping, so `RMP_SYNC` defaults to off. When an
   operator enables it, 5Cycle uses the same unofficial search the site's own
   frontend uses and stores a link to the professor's real rating page plus the
   mirrored score. Where no mirror exists the UI shows an RMP *search link* and
   says so plainly — it never invents a score. Native 5Cycle reviews are the
   real rating system today (only seed data exists so far).
4. **Auth is development-grade.** Passwords are scrypt-hashed and sessions are
   HMAC-signed, but `CYCLE_SESSION_SECRET` falls back to a hardcoded dev value.
   **Set that env var before deploying anywhere**, and plan on campus SSO for real use.
5. **Freshness is bounded upstream, not by us.** 5Cycle polls the public
   HyperSchedule v4 API (default every 60 min); the consortium registrar
   publishes each school's sections on its own schedule (Mudd is usually the
   last portal to go live). An announced term whose sections aren't loaded
   yet shows as *pending* in the auto-sync status and self-resolves. If
   banana.hyperschedule.io is unreachable, 5Cycle serves the last cached
   snapshot and keeps retrying.

## Traps already paid for

- `enrollments.section_id` is `ON DELETE CASCADE` off `sections`. Re-syncing a term
  by `DELETE FROM sections` silently wipes every student's saved plan. Sync now
  deletes only sections that vanished upstream and upserts with
  `INSERT ... ON CONFLICT DO UPDATE`. `INSERT OR REPLACE` is also wrong here —
  REPLACE does an implicit DELETE and fires the same cascade.
- `terms.is_current` is owned by the **term-list** sync (`syncTermListFrom`).
  When section ingest upserts the current term's row, an `ON CONFLICT …
  is_current = excluded.is_current` clause silently un-marked it (the
  `current_term` meta still said one thing, the table the other). The
  conflict clause now leaves `is_current` alone for existing rows.
- Tailwind v4 cannot `@apply` one custom utility class inside another. The shared
  button base is a grouped selector, not `@apply btn`.
- `lib/session.ts` stores the **unsigned** token in the `sessions` table but sets
  the **signed** token in the cookie; the lookup must strip the signature or every
  session fails.
- Terms sort by `termChronoKey()`, not by string. Lexicographic order puts `SP2027`
  before `FA2026`.
- `actions/auth.ts` needs the `"use server"` directive: `components/Nav.tsx` passes
  `logoutAction` straight to `<form action={…}>`, and without the directive it
  serializes as a plain function, which throws on **every** page for signed-in users.
