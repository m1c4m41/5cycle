import Link from "next/link";
import type { ReviewRow } from "@/lib/types";
import { Stars } from "./Stars";
import { ReviewOwnerActions } from "./ReviewOwnerActions";

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function ReviewCard({
  r,
  mine,
  professor,
}: {
  r: ReviewRow;
  mine: boolean;
  /** Set on cross-professor lists so each review says who it is about. */
  professor?: { id: string; name: string };
}) {
  const takeAgain =
    r.take_again === null || r.take_again === undefined
      ? null
      : Boolean(Number(r.take_again));
  return (
    <article className={"card card-pad" + (mine ? " ring-1 ring-brand-500/30" : "")}>
      {professor && (
        <p className="mb-1.5 text-sm font-semibold text-ink-900">
          <Link href={`/professors/${encodeURIComponent(professor.id)}`} className="hover:underline">
            {professor.name}
          </Link>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Stars value={num(r.stars)} size={15} />
        {r.difficulty !== null && r.difficulty !== undefined ? (
          <span className="text-[11px] font-medium text-ink-600 tabular-nums">
            Difficulty {Number(r.difficulty).toFixed(1)}/5
          </span>
        ) : null}
        {r.workload ? (
          <span className="chip border-ink-200 bg-ink-50 text-ink-600">{r.workload} workload</span>
        ) : null}
        {r.grade ? (
          <span className="chip border-sky-200 bg-sky-50 text-sky-800">Grade: {r.grade}</span>
        ) : null}
        {takeAgain !== null ? (
          <span
            className={
              "chip " +
              (takeAgain
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800")
            }
          >
            {takeAgain ? "Would take again" : "Would not take again"}
          </span>
        ) : null}
        {mine ? (
          <span className="chip border-brand-300 bg-brand-500/10 text-brand-700">your review</span>
        ) : null}
      </div>

      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-700">{r.text}</p>

      {r.tags ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {r.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .map((t, i) => (
              <span key={`${t}-${i}`} className="chip border-amber-200 bg-amber-50 text-amber-800">
                {t}
              </span>
            ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink-100 pt-2 text-xs text-ink-500">
        <span className="font-semibold text-ink-700">Anonymous</span>
        {r.section_id ? (
          <>
            <span className="text-ink-300">·</span>
            <Link
              href={`/section/${encodeURIComponent(String(r.section_id))}`}
              className="link font-mono"
              title="The offering this review was written for"
            >
              {r.course_code ?? "course"}
            </Link>
          </>
        ) : r.course_code ? (
          <>
            <span className="text-ink-300">·</span>
            <span className="font-mono">{r.course_code}</span>
          </>
        ) : null}
        <span className="text-ink-300">·</span>
        <time dateTime={r.created_at}>{r.created_at.slice(0, 10)}</time>
        {mine ? <ReviewOwnerActions reviewId={r.id} professorId={r.instructor_id} /> : null}
      </div>
    </article>
  );
}
