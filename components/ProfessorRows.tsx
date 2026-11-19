import Link from "next/link";
import { SCHOOL_BY_CODE } from "@/lib/constants";
import type { Row } from "@/lib/professors-list";
import { Stars } from "@/components/Stars";
import { RmpScore } from "@/components/RmpScore";

/** node:sqlite hands us numbers; keep null/NaN out of the render path. */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function CampusBadge({ code }: { code: string | null }) {
  const s = code ? SCHOOL_BY_CODE[code] : undefined;
  if (!s) {
    return (
      <span className="chip border-ink-200 bg-ink-50 text-ink-400" title="Campus not recorded">
        5C
      </span>
    );
  }
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


/** Table rows (sm and up). */
export function ProfessorTrs({ rows }: { rows: Row[] }) {
  return (
    <>
      {rows.map((r) => (
          <tr key={r.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/70">
            <td className="px-4 py-2.5">
              <Link
                href={`/professors/${encodeURIComponent(r.id)}`}
                className="break-words font-semibold text-ink-900 hover:underline"
              >
                {r.name}
              </Link>
            </td>
            <td className="px-2 py-2.5">
              <CampusBadge code={r.home_school} />
            </td>
            <td className="px-2 py-2.5 text-right text-ink-600 tabular-nums">
              {r.section_count ?? 0}
            </td>
            <td className="px-2 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Stars
                  value={num(r.avg_stars)}
                  href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                  title="View written reviews"
                />
                <Link
                  href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                  className="text-[11px] text-ink-400 hover:text-ink-700 hover:underline"
                >
                  {r.review_count ?? 0} review{(r.review_count ?? 0) === 1 ? "" : "s"}
                </Link>
              </div>
            </td>
            <td className="px-2 py-2.5">
              <Link
                href={`/professors/${encodeURIComponent(r.id)}#write-review`}
                className="btn-ghost px-2 py-1 text-xs"
                title="Write an anonymous review (one per account, editable later)"
              >
                Write one
              </Link>
            </td>
            <td className="px-4 py-2.5">
              <RmpScore
                name={r.name}
                schoolCode={r.home_school}
                quality={num(r.rmp_quality)}
                difficulty={num(r.rmp_difficulty)}
                numRatings={num(r.rmp_num_ratings)}
                url={r.rmp_url}
              />
            </td>
          </tr>
      ))}
    </>
  );
}

/** Stacked cards (below sm). */
export function ProfessorLis({ rows, ayLabel }: { rows: Row[]; ayLabel: string }) {
  return (
    <>
      {rows.map((r) => (
        <li key={r.id} className="card card-pad">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/professors/${encodeURIComponent(r.id)}`}
              className="text-base font-semibold text-ink-900 hover:underline"
            >
              {r.name}
            </Link>
            <CampusBadge code={r.home_school} />
          </div>
          <div className="mt-2 space-y-1.5 text-sm">
            <div className="flex items-center gap-1.5">
              <Stars
                value={num(r.avg_stars)}
                href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                title="View written reviews"
              />
              <Link
                href={`/professors/${encodeURIComponent(r.id)}#reviews`}
                className="text-[11px] text-ink-400 hover:text-ink-700 hover:underline"
              >
                {r.review_count ?? 0} review{(r.review_count ?? 0) === 1 ? "" : "s"}
              </Link>
              <Link
                href={`/professors/${encodeURIComponent(r.id)}#write-review`}
                className="btn-ghost px-2 py-0.5 text-[11px]"
              >
                Write one
              </Link>
            </div>
            <div>
              <span className="text-[11px] uppercase tracking-wide text-ink-400">
                RateMyProfessors
              </span>
              <RmpScore
                className="mt-0.5"
                name={r.name}
                schoolCode={r.home_school}
                quality={num(r.rmp_quality)}
                difficulty={num(r.rmp_difficulty)}
                numRatings={num(r.rmp_num_ratings)}
                url={r.rmp_url}
              />
            </div>
            <p className="text-xs text-ink-500">
              <Link href={`/professors/${encodeURIComponent(r.id)}`} className="link">
                Full profile
              </Link>
              {" · "}
              {r.section_count ?? 0} section{(r.section_count ?? 0) === 1 ? "" : "s"} in {ayLabel}
            </p>
          </div>
        </li>
      ))}
    </>
  );
}
