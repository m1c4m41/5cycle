import Link from "next/link";
import { notFound } from "next/navigation";
import { get } from "@/lib/db";
import { instructorReviews, instructorSummary, reviewTagsFor, sectionsTaughtBy } from "@/lib/read";
import { currentUser } from "@/lib/session";
import { SCHOOL_BY_CODE } from "@/lib/constants";
import { termLabel } from "@/lib/util";
import type { ReviewRow } from "@/lib/types";
import { Stars } from "@/components/Stars";
import { RmpScore } from "@/components/RmpScore";
import { ReviewForm } from "@/components/ReviewForm";
import { ReviewCard } from "@/components/ReviewCard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function generateMetadata({ params }: Params) {
  const { id } = await params;
  const s = await instructorSummary(decodeURIComponent(id));
  if (!s) return { title: "Professor not found" };
  return {
    title: s.name,
    description:
      s.review_count > 0
        ? `${s.name}: ${s.avg_stars?.toFixed(1) ?? "—"}/5 from ${s.review_count} 5Cycle review${
            s.review_count === 1 ? "" : "s"
          }, plus the mirrored RateMyProfessors score and courses taught.`
        : `${s.name}: courses taught at the Claremont Colleges. No 5Cycle reviews yet.`,
  };
}

function CampusBadge({ code }: { code: string | null }) {
  const s = code ? SCHOOL_BY_CODE[code] : undefined;
  if (!s)
    return (
      <span className="chip border-ink-200 bg-ink-50 text-ink-400" title="Campus not recorded">
        5C
      </span>
    );
  return (
    <span
      className="chip"
      style={{
        borderColor: `color-mix(in srgb, ${s.accent} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${s.accent} 8%, transparent)`,
        color: s.accent,
      }}
      title={s.name}
    >
      {s.short}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-lg font-bold text-ink-900 tabular-nums">{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      {hint ? <div className="text-[11px] text-ink-400">{hint}</div> : null}
    </div>
  );
}

export default async function ProfessorPage({ params }: Params) {
  const { id } = await params;
  const instructorId = decodeURIComponent(id);

  const summary = await instructorSummary(instructorId);
  if (!summary) notFound();

  const reviews = await instructorReviews(instructorId);
  const tags = await reviewTagsFor(instructorId);
  const sections = await sectionsTaughtBy(instructorId);
  const user = await currentUser();

  // instructorReviews() doesn't expose user_id, so resolve "mine" by id lookup.
  const mineRow = user
    ? await get<{ id: string }>(
        "SELECT id FROM reviews WHERE instructor_id = ? AND user_id = ? LIMIT 1",
        [instructorId, user.id],
      )
    : undefined;
  const mine = mineRow ? reviews.find((r) => r.id === mineRow.id) ?? null : null;

  const profileHref = `/professors/${encodeURIComponent(summary.id)}`;
  const rmpTags = (summary.rmp_tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const byTerm = new Map<string, typeof sections>();
  for (const s of sections) {
    const list = byTerm.get(s.term_id);
    if (list) list.push(s);
    else byTerm.set(s.term_id, [s]);
  }

  const bothScores = summary.avg_stars !== null && summary.rmp_quality !== null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/professors" className="text-sm text-ink-500 hover:text-ink-800 hover:underline">
          ← All professors
        </Link>
        <Link href={`/catalog?instructor=${encodeURIComponent(summary.name)}`} className="link text-sm">
          Search the catalog for this name →
        </Link>
      </div>

      {/* --------------------------------- header -------------------------------- */}
      <header className="card card-pad">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-ink-900">{summary.name}</h1>
              <CampusBadge code={summary.home_school} />
            </div>
            <p className="mt-1 text-sm text-ink-500">
              {summary.section_count} section{summary.section_count === 1 ? "" : "s"} in the catalog
              {summary.home_school ? ` · home campus ${SCHOOL_BY_CODE[summary.home_school]?.name ?? summary.home_school}` : ""}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  5Cycle students
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <Stars
                    value={num(summary.avg_stars)}
                    size={20}
                    title="Click to read the reviews"
                    href="#reviews"
                  />
                  <span className="text-xs text-ink-500">
                    {summary.review_count} review{summary.review_count === 1 ? "" : "s"}
                  </span>
                </div>
                {summary.avg_difficulty !== null ? (
                  <div className="mt-0.5 text-xs text-ink-600 tabular-nums">
                    Avg difficulty {summary.avg_difficulty.toFixed(1)}/5
                  </div>
                ) : (
                  <div className="mt-0.5 text-xs text-ink-400">no difficulty ratings yet</div>
                )}
              </div>

              <div className="border-ink-200 sm:border-l sm:pl-5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  External mirror
                </div>
                <div className="mt-1">
                  <RmpScore
                    name={summary.name}
                    schoolCode={summary.home_school}
                    quality={num(summary.rmp_quality)}
                    difficulty={num(summary.rmp_difficulty)}
                    numRatings={num(summary.rmp_num_ratings)}
                    url={summary.rmp_url}
                  />
                  {num(summary.rmp_quality) !== null && summary.rmp_synced_at && (
                    <p
                      className={
                        Date.now() - new Date(summary.rmp_synced_at).getTime() > 365 * 86400_000
                          ? "mt-1 text-[11px] font-medium text-amber-700"
                          : "mt-1 text-[11px] text-ink-400"
                      }
                      title="RateMyProfessors figures are reloaded once a year from a curated list"
                    >
                      RMP data updated {new Date(summary.rmp_synced_at).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
                      {Date.now() - new Date(summary.rmp_synced_at).getTime() > 365 * 86400_000
                        ? " — over a year old, may be out of date"
                        : ""}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="w-full shrink-0 space-y-2 sm:w-56">
            <Link href={`/catalog?instructor=${encodeURIComponent(summary.name)}`} className="btn-primary w-full">
              Find their open sections
            </Link>
            {mine ? (
              <a href={`${profileHref}#edit-review`} className="btn-secondary w-full">
                Edit your review
              </a>
            ) : (
              <a href={`${profileHref}#write-review`} className="btn-secondary w-full">
                Write a review
              </a>
            )}
          </div>
        </div>

        {/* --------------------------- our avg vs RMP strip --------------------------- */}
        {bothScores ? (
          <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              Two different populations
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-ink-200 bg-white p-3">
                <Stat
                  label="5Cycle reviews"
                  value={`${summary.avg_stars?.toFixed(2) ?? "—"}/5`}
                  hint={`${summary.review_count} from students here · difficulty ${
                    summary.avg_difficulty?.toFixed(1) ?? "—"
                  }/5`}
                />
              </div>
              <div className="rounded-lg border border-amber-200 bg-white p-3">
                <Stat
                  label="RateMyProfessors"
                  value={`${summary.rmp_quality?.toFixed(1) ?? "—"}/5`}
                  hint={`${
                    summary.rmp_num_ratings ?? "unknown number of"
                  } ratings on RateMyProfessors · difficulty ${
                    summary.rmp_difficulty !== null ? summary.rmp_difficulty.toFixed(1) : "—"
                  }/5`}
                />
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
              These are not the same group of students: our numbers come only from signed-in 5Cycle
              users, the RateMyProfessors number is nationwide third-party data we mirror. The gap
              between them is information, not an error.
            </p>
          </div>
        ) : null}

        {/* --------------------------------- tags --------------------------------- */}
        {tags.length > 0 || rmpTags.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-ink-100 pt-3">
            {tags.map((t) => (
              <Link
                key={t}
                href={`/professors?q=${encodeURIComponent(summary.name)}`}
                className="chip border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100"
                title="Tag used by 5Cycle reviewers"
              >
                {t}
              </Link>
            ))}
            {rmpTags.length > 0 ? (
              <span className="text-[11px] text-ink-400">RMP says:</span>
            ) : null}
            {rmpTags.map((t) => (
              <span
                key={`rmp-${t}`}
                className="chip border-ink-200 bg-white text-ink-500"
                title="Tag mirrored from RateMyProfessors (external)"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      {/* -------------------------------- reviews -------------------------------- */}
      <section aria-labelledby="reviews-heading" className="space-y-3" id="reviews">
        <h2 id="reviews-heading" className="text-lg font-bold text-ink-900">
          Reviews{" "}
          <span className="text-sm font-normal text-ink-500">
            ({reviews.length} from 5Cycle students)
          </span>
        </h2>

        {reviews.length === 0 ? (
          <div className="card card-pad">
            <p className="text-sm text-ink-600">
              No 5Cycle reviews of {summary.name} yet. Taken a class with them? You&apos;d be the
              first.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {reviews.map((r) => (
              <li key={r.id}>
                <ReviewCard r={r} mine={mine?.id === r.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------- write/edit ------------------------------ */}
      <div id="write-review" className="scroll-mt-20">
        {user ? (
          <div id="edit-review" className="scroll-mt-20">
            <ReviewForm
              instructorId={summary.id}
              instructorName={summary.name}
              userId={user.id}
              existing={mine}
            />
          </div>
        ) : (
          <section className="card card-pad">
            <h3 className="text-base font-bold text-ink-900">Sign in to review</h3>
            <p className="mt-1 text-sm text-ink-600">
              Reviews are tied to a 5Cycle account so each student counts once per professor.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href={`/login?next=${encodeURIComponent(profileHref)}`}
                className="btn-primary"
              >
                Sign in to review
              </Link>
              <Link href={`/signup?next=${encodeURIComponent(profileHref)}`} className="btn-secondary">
                Create an account
              </Link>
            </div>
          </section>
        )}
      </div>

      {/* ----------------------------- courses taught ---------------------------- */}
      <section aria-labelledby="courses-heading" className="space-y-3">
        <h2 id="courses-heading" className="text-lg font-bold text-ink-900">
          Courses taught{" "}
          <span className="text-sm font-normal text-ink-500">
            ({sections.length} section{sections.length === 1 ? "" : "s"})
          </span>
        </h2>

        {sections.length === 0 ? (
          <div className="card card-pad">
            <p className="text-sm text-ink-600">
              No sections on record for this name — the catalog only lists instructors the registrar
              publishes.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {[...byTerm.entries()].map(([term, list]) => (
              <div key={term} className="card card-pad">
                <h3 className="text-sm font-bold text-ink-800">
                  {termLabel(term)}
                  <span className="ml-1.5 text-xs font-normal text-ink-400">
                    {list.length} section{list.length === 1 ? "" : "s"}
                  </span>
                </h3>
                <ul className="mt-2 divide-y divide-ink-100">
                  {list.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
                      <Link
                        href={`/section/${encodeURIComponent(s.id)}`}
                        className="font-mono text-sm font-semibold text-ink-900 hover:underline"
                      >
                        {s.code_string}
                      </Link>
                      <CampusBadge code={s.school} />
                      <Link
                        href={`/section/${encodeURIComponent(s.id)}`}
                        className="min-w-0 flex-1 truncate text-sm text-ink-600 hover:text-ink-900 hover:underline"
                      >
                        {s.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-[11px] leading-relaxed text-ink-400">
        RateMyProfessors figures are third-party content for comparison only; 5Cycle is not
        affiliated with RateMyProfessors and does not scrape it (no public API), so any score above
        came from a curated local import.
      </p>
    </div>
  );
}
