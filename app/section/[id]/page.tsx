/**
 * Section detail — everything the registrar feed shows about one section (title,
 * description, course areas, professors, school, credits, times, seats), plus
 * the planner-specific parts: requirement fulfilment for *this* student, the
 * cross-campus registrar portal hand-off, and professor reviews.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { EnrollButton } from "@/components/EnrollButton";
import { ReviewForm } from "@/components/ReviewForm";
import { RmpScore } from "@/components/RmpScore";
import { SchoolBadge, SeatsMeter } from "@/components/SectionCard";
import { PrereqText } from "@/components/PrereqText";
import { extractPrerequisites } from "@/lib/prereq";
import { Stars } from "@/components/Stars";
import { all, get } from "@/lib/db";
import { AFFILIATION_LABELS, SCHOOL_BY_CODE, STATUS_LABELS } from "@/lib/constants";
import { getSection, searchSections } from "@/lib/catalog";
import { refreshInBackground } from "@/lib/refresh";
import { enrolledSections } from "@/lib/schedule";
import { fulfillmentFor, setsForUser } from "@/lib/requirements";
import { permNeededFor } from "@/lib/perm";
import { instructorReviews, instructorSummary } from "@/lib/read";
import { currentUser } from "@/lib/session";
import {
  formatCredits,
  formatMeeting,
  schoolName,
  schoolShort,
  secondsTo12h,
  termLabel,
} from "@/lib/util";

export const dynamic = "force-dynamic";

/** First value of a search param, trimmed — for ?ok= / ?err= round-trip notices. */
function spNotice(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSection(decodeURIComponent(id));
  if (!s) return { title: "Course not found · 5Cycle" };
  return {
    title: `${s.code_string} ${s.title} · 5Cycle`,
    description: `${termLabel(s.term_id)} · ${schoolShort(s.school)} · ${formatCredits(
      s.credits_5c,
      s.school,
    )}${s.instructors.length ? ` · ${s.instructors.map((i) => i.name).join(", ")}` : ""}`,
  };
}

export default async function SectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const s = await getSection(decodeURIComponent(id));
  if (!s) notFound();
  refreshInBackground(s.term_id);

  const user = await currentUser();
  const planned = user ? await enrolledSections(user.id, s.term_id) : [];
  const inPlan = planned.some((p) => p.id === s.id);

  const sets = user ? await setsForUser(user) : [];
  const fits = sets.length ? fulfillmentFor(s, sets) : [];

  // Other sections of the same course this term — the practical reason people
  // land here is "which discussion/lab time is open".
  const siblings = (
    await searchSections({
      term: s.term_id,
      departments: [s.department],
      q: `${s.department} ${String(s.course_number).padStart(3, "0")}${s.suffix}`,
      limit: 40,
    })
  ).rows.filter(
    (o) =>
      o.id !== s.id &&
      o.department === s.department &&
      o.course_number === s.course_number &&
      o.suffix === s.suffix,
  );

  const perm = user ? permNeededFor(user.school, s) : false;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-ink-500">
        <Link href={`/catalog?term=${s.term_id}`} className="link">
          Catalog
        </Link>
        <span>/</span>
        <Link href={`/catalog?term=${s.term_id}&dept=${s.department}`} className="link">
          {s.department}
        </Link>
        <span>/</span>
        <span className="font-mono text-ink-700">{s.code_string}</span>
      </nav>

      {spNotice(sp.err) && (
        <div className="card card-pad border-red-300 bg-red-50 text-sm text-red-800">
          {spNotice(sp.err)}
        </div>
      )}
      {spNotice(sp.ok) && (
        <div className="card card-pad border-emerald-300 bg-emerald-50 text-sm text-emerald-800">
          {spNotice(sp.ok)}
        </div>
      )}

      <header className="card card-pad space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <h1 className="font-mono text-2xl font-bold tracking-tight">
                {s.department} {String(s.course_number).padStart(3, "0")}
                {s.suffix}
              </h1>
              <SchoolBadge code={s.school} />
              <span className="chip border-ink-300 bg-ink-50 text-ink-600">
                {s.section_number}
              </span>
              {s.affiliation !== s.school && (
                <span
                  className="chip border-ink-300 bg-ink-100 text-ink-600"
                  title={`Cross-listed affiliation ${s.affiliation}`}
                >
                  {AFFILIATION_LABELS[s.affiliation] ?? s.affiliation}
                </span>
              )}
              {s.half && (
                <span className="chip border-ink-300 bg-ink-50 text-ink-600">{s.half}</span>
              )}
            </div>
            <p className="text-lg font-medium text-ink-900">{s.title || "Untitled course"}</p>
            <p className="text-sm text-ink-600">
              {termLabel(s.term_id)} · {schoolName(s.school)} ·{" "}
              <strong>{formatCredits(s.credits_5c, s.school)}</strong>
              {s.school === "HM" && (
                <span className="text-ink-500">
                  {" "}
                  ({s.credits} on HMC&apos;s 3-credit-per-course scale)
                </span>
              )}
              {s.start_date && s.end_date && (
                <span className="text-ink-500"> · {s.start_date} → {s.end_date}</span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <EnrollButton
              sectionId={s.id}
              inPlan={inPlan}
              label={user ? "Add to plan" : "Sign in to plan"}
              next={`/section/${encodeURIComponent(s.id)}`}
            />
            <div className="text-right text-xs text-ink-500">
              {STATUS_LABELS[s.status] ?? s.status}
            </div>
          </div>
        </div>

        {s.potential_error === 1 && (
          <p className="chip border-amber-400 bg-amber-50 text-amber-800">
            Upstream flagged this record as possibly malformed — confirm with the registrar before
            planning on it.
          </p>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7">
          <section className="card card-pad space-y-3">
            <h2 className="text-lg font-bold">Description</h2>
            {extractPrerequisites(s.description) && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-ink-700">
                <span className="font-semibold text-amber-800">Prerequisites:</span>{" "}
                <PrereqText text={extractPrerequisites(s.description)!} />
              </p>
            )}
            {s.description ? (
              <p className="whitespace-pre-line text-sm leading-relaxed text-ink-700">
                {s.description}
              </p>
            ) : (
              <p className="text-sm text-ink-500">
                No description on file for this section. Course-area
                designations and meeting times below are still authoritative for what the course
                counts toward; the official syllabus lives with the department.
              </p>
            )}
          </section>

          <section className="card card-pad space-y-3">
            <h2 className="text-lg font-bold">Professors</h2>
            {s.instructors.length === 0 ? (
              <p className="text-sm text-ink-500">
                No instructor listed yet. The feed attaches faculty when the department publishes
                them, usually close to registration opening.
              </p>
            ) : (
              <ul className="space-y-3">
                {s.instructors.map(async (i) => {
                  const full = await instructorSummary(i.id);
                  return (
                    <li key={i.id} className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={`/professors/${encodeURIComponent(i.id)}`}
                          className="font-medium text-ink-900 hover:underline"
                        >
                          {i.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-600">
                          <Stars
                            hideEmpty
                            value={i.avg_stars}
                            title="5Cycle students — click to read the reviews"
                            href={`/professors/${encodeURIComponent(i.id)}#reviews`}
                          />
                          <span>
                            {i.review_count} 5Cycle review{i.review_count === 1 ? "" : "s"}
                          </span>
                          {full?.avg_difficulty != null && (
                            <span>· difficulty {full.avg_difficulty.toFixed(1)}/5</span>
                          )}
                        </div>
                      </div>
                      <RmpScore
                        quality={i.rmp_quality}
                        difficulty={full?.rmp_difficulty ?? null}
                        numRatings={i.rmp_num_ratings}
                        url={i.rmp_url}
                        name={i.name}
                        schoolCode={s.school}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-ink-500">
              We don&apos;t scrape RateMyProfessors, so RMP scores only appear where they were
              imported by hand. Professors without a score link out to an RMP search instead of
              showing a number — we never estimate a score.
            </p>
          </section>

          <ReviewThread
            instructors={s.instructors}
            userId={user?.id ?? null}
            sectionId={s.id}
          />

          {siblings.length > 0 && (
            <section className="card card-pad space-y-2">
              <h2 className="text-lg font-bold">
                Other sections of {s.department} {String(s.course_number).padStart(3, "0")}
                {s.suffix} in {termLabel(s.term_id)}
              </h2>
              <ul className="divide-y divide-ink-100 text-sm">
                {siblings.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link
                      href={`/section/${encodeURIComponent(o.id)}`}
                      className="font-mono text-ink-800 hover:underline"
                    >
                      {o.code_string} · {o.section_number}
                    </Link>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
                      <SchoolBadge code={o.school} small />
                      {o.meetings.length ? formatMeeting(o.meetings[0]) : "time TBD"}
                      <span>
                        {o.seats_total > 0
                          ? `${Math.max(o.seats_total - o.seats_filled, 0)} open`
                          : "seats n/a"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="space-y-6 lg:col-span-5">
          <section className="card card-pad space-y-3">
            <h2 className="text-lg font-bold">Meeting times</h2>
            {s.meetings.length === 0 ? (
              <p className="text-sm text-ink-500">
                No scheduled meetings in the feed — asynchronous, TBA, or a block term whose dates
                aren&apos;t published yet.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {s.meetings.map((m, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-ink-900">
                      {m.days || "—"} {secondsTo12h(m.start_time)}–{secondsTo12h(m.end_time)}
                    </span>
                    {m.locations && <span className="text-xs text-ink-500">{m.locations}</span>}
                  </li>
                ))}
              </ul>
            )}
            <SeatsMeter s={s} />
            {s.perm_count > 0 && (
              <p className="text-xs text-ink-600">
                <strong>{s.perm_count}</strong> seat{
                  s.perm_count === 1 ? "" : "s"
                } reserved by the teaching campus for 5C cross-registration. Reserved seats are
                what your perm request competes for — availability is not guaranteed by this
                number.
              </p>
            )}
          </section>

          <section className="card card-pad space-y-2">
            <h2 className="text-lg font-bold">Course areas</h2>
            {s.areas.length === 0 ? (
              <p className="text-sm text-ink-500">
                No registrar designations on this record.
              </p>
            ) : (
              <>
                <ul className="flex flex-wrap gap-1.5">
                  {s.areas.map((a) => (
                    <li key={a.code}>
                      <Link
                        href={`/catalog?term=${s.term_id}&area=${a.code}`}
                        className={`chip hover:border-brand-400 ${
                          a.kind === "ge"
                            ? "border-brand-300 bg-brand-50 text-brand-800"
                            : "border-ink-300 bg-ink-50 text-ink-700"
                        }`}
                        title={`${a.description} (${a.kind === "ge" ? "general education" : "department"})`}
                      >
                        <span className="font-mono">{a.code}</span>
                        <span className="max-w-[14rem] truncate">{a.description}</span>
                        {a.school && (
                          <span className="text-ink-400">{schoolShort(a.school)}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-ink-500">
                  Numeric prefixes are campus GE families (1 Pomona, 2 Scripps, 3 CMC, 4 Harvey
                  Mudd, 5 Pitzer). One course can satisfy several campuses&apos; GE at once, which
                  is why you may see more than one.
                </p>
              </>
            )}
          </section>

          {fits.length > 0 && (
            <section className="card card-pad space-y-2">
              <h2 className="text-lg font-bold">What this advances for you</h2>
              <ul className="space-y-1 text-sm">
                {fits.map((f) => (
                  <li key={f.groupId} className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`chip ${
                        f.kind === "ge"
                          ? "border-brand-300 bg-brand-50 text-brand-800"
                          : "border-emerald-300 bg-emerald-50 text-emerald-800"
                      }`}
                    >
                      {f.kind}
                    </span>
                    <span className="text-ink-700">{f.setName}</span>
                    <span className="text-ink-400">·</span>
                    <span className="text-ink-600">{f.groupName}</span>
                  </li>
                ))}
              </ul>
              <Link href={`/requirements?term=${s.term_id}`} className="link text-sm">
                See the whole checklist
              </Link>
              {inPlan && (
                <p className="text-xs text-ink-500">
                  Whether a slot ticks over depends on the rest of your plan: a group already
                  filled by another course will not count a second one.
                </p>
              )}
            </section>
          )}

          {user && (
            <section id="perm" className="card card-pad space-y-3 scroll-mt-20">
              {perm ? (
                <>
                  <h2 className="text-lg font-bold">Cross-campus course</h2>
                  <p className="text-sm text-ink-700">
                    This section is at {schoolName(s.school)}, not your home campus, so you register
                    for it through your {schoolName(user.school)} cross-registration (perm) process.
                  </p>
                  <a
                    href={SCHOOL_BY_CODE[user.school].registrarUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary w-full"
                  >
                    Open {schoolShort(user.school)} registrar portal
                  </a>
                  <p className="text-xs text-ink-600">
                    Opens in a new tab behind campus SSO. From there, pick the cross-registration /
                    perm form and enter this section&apos;s details — code, term, credits and
                    meeting times are all on this page.
                  </p>
                </>
              ) : (
                <p className="text-sm text-ink-600">
                  No perm needed — this is a {schoolShort(s.school)} course and that is your home
                  campus. Perms only apply when you register across campuses.
                </p>
              )}
            </section>
          )}

          {!user && (
            <section className="card card-pad space-y-2">
              <h2 className="text-lg font-bold">Plan this course</h2>
              <p className="text-sm text-ink-600">
                Create a free account to save courses, see what they satisfy, and get your
                campus registrar portal link for cross-registration.
              </p>
              <div className="flex gap-2">
                <Link href="/signup" className="btn-primary">
                  Create account
                </Link>
                <Link href="/login" className="btn-secondary">
                  Sign in
                </Link>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Reviews for every instructor attached to the section, in one thread. */
async function ReviewThread({
  instructors,
  userId,
  sectionId,
}: {
  instructors: { id: string; name: string }[];
  userId: string | null;
  sectionId: string;
}) {
  if (instructors.length === 0) return null;
  return (
    <section className="card card-pad space-y-4">
      <h2 className="text-lg font-bold">Reviews for this section</h2>
      {instructors.map(async (i) => {
        const reviews = await instructorReviews(i.id);
        const mine = userId
          ? await get<{ id: string }>(
              "SELECT id FROM reviews WHERE instructor_id = ? AND user_id = ?",
              [i.id, userId],
            )
          : undefined;
        return (
          <div key={i.id} className="space-y-3">
            <h3 className="text-sm font-semibold text-ink-800">{i.name}</h3>
            {reviews.length === 0 && (
              <p className="text-sm text-ink-500">
                No 5Cycle reviews yet. Be the first — workload, grading and take-again are the
                fields people actually use.
              </p>
            )}
            <ul className="space-y-3">
              {reviews.slice(0, 3).map((r) => (
                <li key={r.id} className="border-l-2 border-ink-200 pl-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
                    <Stars value={r.stars} />
                    {r.difficulty != null && <span>difficulty {r.difficulty}/5</span>}
                    {r.grade && <span>grade {r.grade}</span>}
                    {r.workload && <span>· {r.workload}</span>}
                  </div>
                  <p className="mt-1 text-sm text-ink-700">{r.text}</p>
                  <p className="mt-1 text-[11px] text-ink-400">
                    Anonymous · {r.course_code ?? "course not recorded"} ·{" "}
                    {r.created_at.slice(0, 10)}
                  </p>
                </li>
              ))}
            </ul>
            {reviews.length > 3 && (
              <Link href={`/professors/${encodeURIComponent(i.id)}`} className="link text-sm">
                All {reviews.length} reviews for {i.name}
              </Link>
            )}
            {userId ? (
              <ReviewForm
                instructorId={i.id}
                instructorName={i.name}
                userId={userId}
                existing={mine ? reviews.find((r) => r.id === mine.id) ?? null : null}
                sectionId={sectionId}
              />
            ) : (
              <p className="text-xs text-ink-500">
                <Link href="/login" className="link">
                  Sign in
                </Link>{" "}
                to review this instructor.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
