import Link from "next/link";
import { SCHOOLS } from "@/lib/constants";
import { adminSnapshot } from "@/lib/read";

/**
 * Landing page. Server component on purpose: the numbers below are read from
 * the local catalog on every request, so nothing here is a hard-coded claim
 * about how big the catalog is. `force-dynamic` also keeps the build from
 * baking a snapshot of the counts into a static page.
 */
export const dynamic = "force-dynamic";

/** The five undergraduate colleges. CGU is a graduate campus, so it is excluded. */
const FIVE_C = SCHOOLS.filter((s) => s.code !== "CG");

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white px-3 py-2">
      <p className="text-lg font-bold leading-tight text-ink-900">{n}</p>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</p>
    </div>
  );
}

const FEATURES: { title: string; body: string; href: string; cta: string }[] = [
  {
    title: "The full 5C catalog, in one list",
    body: "One searchable list of every section across the five colleges — full course description, course-area designations, professor(s), teaching campus, credits on both the campus and 5C scales, meeting times, seats and open/closed status. The catalog is pulled straight from the consortium registrar's course feed, so it is the live upstream source, not a spreadsheet someone exported last year.",
    href: "/catalog",
    cta: "Browse the catalog →",
  },
  {
    title: "An account planner that ticks itself",
    body: "Pick your campus, major and minor on your profile. You get a live checklist — campus GE, major requirements, minor requirements — that fills itself in as you add classes to your schedule, so you can see which requirement a section would satisfy before you commit to it, and browse backwards from the gaps you still have.",
    href: "/planner",
    cta: "Open your checklist in the planner →",
  },
  {
    title: "A weekly timetable with conflict detection",
    body: "Every section you plan lands on a Mon–Sun grid at its real meeting time, half-term and irregular meetings included. Overlapping sections are flagged on the spot, so you find out about the clash now rather than during registration.",
    href: "/planner",
    cta: "Open the planner →",
  },
  {
    title: "One click to your registrar portal",
    body: "Taught off your home campus? Cross-registration sections are flagged 'perm needed' and one button opens your home campus registrar portal in a new tab — the section's code, term, credits and meeting times are right there on the page to enter into the form.",
    href: "/catalog?perm=1",
    cta: "Find sections with perm seats →",
  },
  {
    title: "Professor ratings, ours and theirs",
    body: "Every professor page carries our own student reviews — stars, difficulty, workload, grade, take-again, tags and text — and, where we have actually retrieved one, a mirrored RateMyProfessors score next to it. Where we don't, we show a search link. We never display an invented number.",
    href: "/professors",
    cta: "Browse professors →",
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Make an account and say who you are",
    body: "Campus, graduation year, major, minor. That is all the planner needs; nothing is sent to a campus system.",
  },
  {
    title: "Browse the catalog and shortlist sections",
    body: "Filter by term, campus, department, course area, instructor, credits, open seats or perm seats. Each result shows which of your outstanding requirements it would satisfy.",
  },
  {
    title: "Add them to a term and watch the plan update",
    body: "The weekly timetable redraws and flags conflicts; the GE / major / minor checklist ticks itself as requirements are met.",
  },
  {
    title: "Finish registration at your own registrar",
    body: "For off-campus sections the planner opens your home campus registrar portal. The cross-registration form itself is behind campus SSO, so you submit it yourself.",
  },
];

export default async function HomePage() {
  const snap = adminSnapshot();
  const stats = snap.stats;

  const sectionsBySchool = new Map(stats.bySchool.map((r) => [r.school, Number(r.n)]));

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      {/* ------------------------------- hero ------------------------------- */}
      <header className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Plan a year at the Claremont Colleges in one tab
        </h1>
        <p className="max-w-3xl text-base text-ink-600">
          5Cycle puts the whole 5C catalog, your GE / major / minor checklist, a weekly timetable
          with conflict detection, cross-registration perm links and professor reviews in one place.
        </p>

        <div className="flex flex-wrap gap-2">
          <Link href="/catalog" className="btn-primary">
            Browse the catalog
          </Link>
          <Link href="/signup" className="btn-secondary">
            Create an account
          </Link>
          <Link href="/professors" className="btn-ghost">
            Professor reviews
          </Link>
        </div>

        {/* Real numbers, read from the local catalog on this request. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Stat n={stats.sections.toLocaleString()} label="sections" />
          <Stat n={stats.courses.toLocaleString()} label="distinct courses" />
          <Stat n={stats.instructors.toLocaleString()} label="professors" />
          <Stat n={stats.areas.toLocaleString()} label="course areas" />
          <Stat n={snap.requirementSets.toLocaleString()} label="requirement sets" />
          <Stat n={stats.reviews.toLocaleString()} label="student reviews" />
        </div>
      </header>

      {/* --------------------------- campus strip --------------------------- */}
      <section className="card card-pad space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold text-ink-900">Five colleges, one catalog</h2>
          <span className="text-xs text-ink-500">
            Section counts are by teaching campus, current catalog.
          </span>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {FIVE_C.map((s) => (
            <li key={s.code} className="rounded-lg border border-ink-200 bg-ink-50 p-3">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: s.accent }}
                  aria-hidden
                />
                <a
                  className="text-sm font-bold text-ink-900 hover:underline"
                  href={`/catalog?school=${s.code}`}
                >
                  {s.short}
                </a>
                <span className="ml-auto font-mono text-xs text-ink-600">
                  {(sectionsBySchool.get(s.code) ?? 0).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-xs leading-snug text-ink-600">{s.name}</p>
              <p className="mt-1 text-[11px] text-ink-500">
                GE area codes start with <span className="font-mono">{s.gePrefix}</span> ·{" "}
                <a className="link" href={s.registrarUrl} target="_blank" rel="noreferrer">
                  registrar
                </a>
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ----------------------------- features ----------------------------- */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold tracking-tight">What&apos;s in it</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {FEATURES.map((f) => (
            <article key={f.title} className="card card-pad flex flex-col gap-2">
              <h3 className="text-sm font-bold text-ink-900">{f.title}</h3>
              <p className="text-sm leading-relaxed text-ink-600">{f.body}</p>
              <Link href={f.href} className="link mt-auto self-start text-xs">
                {f.cta}
              </Link>
            </article>
          ))}
        </div>
      </section>

      {/* --------------------------- how it works --------------------------- */}
      <section className="card card-pad space-y-3">
        <h2 className="text-lg font-bold tracking-tight">How it works</h2>
        <ol className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">
                {i + 1}
              </span>
              <span>
                <span className="block text-sm font-semibold text-ink-900">{step.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-600">
                  {step.body}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-ink-500">
          Every catalog filter is a plain <span className="kbd">GET</span> query string, so a
          shortlisted view is bookmarkable and shareable — and browsing the catalog works even with
          JavaScript turned off. (Adding sections to a plan and running the sync buttons do need
          JavaScript.)
        </p>
      </section>

      {/* --------------------------- limitations ---------------------------- */}
      <section className="card space-y-3 border-amber-300 bg-amber-50/60 card-pad">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold tracking-tight text-ink-900">
            What this is <em>not</em> — read before you trust it
          </h2>
          <span className="chip border-amber-300 bg-white text-amber-800">Honest limitations</span>
        </div>
        <ul className="space-y-2 text-sm leading-relaxed text-ink-700">
          <li>
            <strong>Independent student project.</strong> 5Cycle is not affiliated with, endorsed by,
            or operated by the Claremont Colleges or any of the five campuses.
          </li>
          <li>
            <strong>Course data comes from the consortium registrar&rsquo;s public feed.</strong> The
            catalog is pulled from the live course feed the registrar publishes and auto-updates as
            new terms appear, so it inherits that feed&rsquo;s refresh timing. Seat counts,
            open/closed status and perm counts move constantly during registration. Always confirm a
            section in your own campus registration system before you act on it.
          </li>
          <li>
            <strong>Requirement checklists are an advising aid.</strong>{" "}
            {snap.requirementSets > 0 ? (
              <>
                The definitions are working defaults derived from registrar course-area designations
                (numbered areas 1x Pomona, 2x Scripps, 3x CMC, 4x HMC, 5x Pitzer) plus common-core
                patterns. Coverage is partial, and the checklists cannot see overrides, waivers,
                AP/IB credit or catalog-year changes:{" "}
                {snap.unverifiedSets.toLocaleString()} of{" "}
                {snap.requirementSets.toLocaleString()} requirement sets are currently marked
                unverified.
              </>
            ) : (
              <>
                The graduation-checklist definitions are under review with the registrar, so the
                checklist tables may be empty on some campuses. Planning courses in the Planner and
                Catalog is not affected.
              </>
            )}{" "}
            Confirm everything with your registrar and your faculty advisor
            before you graduate on the strength of a green tick.
          </li>
          <li>
            <strong>Nothing here registers you for anything.</strong> 5Cycle never submits a form to
            a campus system, holds a seat, or joins a waitlist. It is a planner: it prepares
            information and links, and you do the registration yourself.
          </li>
        </ul>
      </section>
    </div>
  );
}
