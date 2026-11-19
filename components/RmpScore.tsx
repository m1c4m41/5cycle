/**
 * RateMyProfessors score display.
 *
 * Server-renderable (no interactivity beyond a link), so it can sit inside
 * server components like the catalog, professor directory and professor pages.
 *
 * HARD RULE — never invent a number. We do not scrape RMP (no public API, and
 * automated access is against its terms); the mirrored RMP columns are
 * populated only by a curated `data/rmp-manual.json` import — see lib/rmp.ts.
 * When we have nothing for a professor this component says so and hands off to
 * an RMP search instead of showing a placeholder score. It is also visually
 * separate from `<Stars/>` (our own reviews) because the two numbers come
 * from different populations.
 *
 * Note: server component. Do not import it into a "use client" module —
 * lib/rmp.ts pulls in node:fs / node:sqlite.
 */
import { rmpCollegeLinks, rmpSearchUrl } from "@/lib/rmp";
import { schoolShort } from "@/lib/util";
import { cn } from "@/lib/util";

export type RmpScoreProps = {
  /** Mirrored RMP quality (0–5). Absent → we render the "look it up" state. */
  quality?: number | null;
  /** Mirrored RMP difficulty (1–5). */
  difficulty?: number | null;
  /** How many RMP ratings the mirrored score is based on. */
  numRatings?: number | null;
  /** Direct RMP profile URL, when we have one. */
  url?: string | null;
  /** Professor name — used to build a search deep link when unmirrored. */
  name: string;
  /** Campus code to narrow the search link. */
  schoolCode?: string | null;
  className?: string;
  /** Also list the search at each of the other 5Cs (professor profile page). */
  showOtherColleges?: boolean;
};

/** ↗ — marks the number as belonging to another site. */
function OutwardIcon() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3 shrink-0"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 2.5H9.5V7.5" />
      <path d="M9.5 2.5L3.5 8.5" />
    </svg>
  );
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");

export function RmpScore({
  quality,
  difficulty,
  numRatings,
  url,
  name,
  schoolCode,
  className,
  showOtherColleges,
}: RmpScoreProps) {
  const hasScore = typeof quality === "number" && Number.isFinite(quality);

  /* ----------------- a profile link but no score loaded: link straight to it ----------------- */
  if (!hasScore && url) {
    return (
      <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800"
          title={`Open ${name}'s RateMyProfessors profile in a new tab`}
        >
          <OutwardIcon />
          View on RateMyProfessors
        </a>
      </span>
    );
  }

  /* ------------------------- no mirrored data: say so ------------------------ */
  if (!hasScore) {
    return (
      <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
        <a
          href={rmpSearchUrl(name, schoolCode ?? undefined)}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 underline decoration-ink-300 underline-offset-2 hover:text-ink-700"
          title={`Search RateMyProfessors for ${name}${schoolCode ? ` at ${schoolShort(schoolCode)}` : " across all schools"} (opens in a new tab)`}
        >
          <OutwardIcon />
          Search RateMyProfessors{schoolCode ? ` (${schoolShort(schoolCode)})` : ""}
        </a>
        {showOtherColleges && (
          <span className="basis-full text-[11px] text-ink-400">
            Listed under another 5C?{" "}
            {rmpCollegeLinks(name, schoolCode)
              .filter((l) => l.code !== schoolCode)
              .map((l, i) => (
                <span key={l.code}>
                  {i > 0 && " · "}
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="underline decoration-ink-300 underline-offset-2 hover:text-ink-700"
                  >
                    {schoolShort(l.code)}
                  </a>
                </span>
              ))}
          </span>
        )}
      </span>
    );
  }

  /* ------------------------------ mirrored score ----------------------------- */
  const good = quality >= 3.5;
  const counts =
    typeof numRatings === "number" && Number.isFinite(numRatings)
      ? `${numRatings.toLocaleString()} RMP rating${numRatings === 1 ? "" : "s"}`
      : "rating count unknown";

  const pill = (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-xs font-bold tabular-nums",
        good
          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
          : "border-amber-300 bg-amber-50 text-amber-800",
      )}
      title={`RateMyProfessors quality ${quality.toFixed(2)} out of 5, from ${counts}. External data — not our students' ratings.`}
    >
      {fmt(quality)}
      <span className="text-[10px] font-medium opacity-70">/5</span>
    </span>
  );

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1"
          title={`Open ${name}'s RateMyProfessors profile in a new tab`}
        >
          {pill}
          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-ink-500 hover:text-ink-700 hover:underline">
            <OutwardIcon />
            RateMyProfessors
          </span>
        </a>
      ) : (
        <>
          {pill}
          <span className="text-[11px] font-medium text-ink-500">RateMyProfessors</span>
        </>
      )}

      {typeof difficulty === "number" && Number.isFinite(difficulty) && (
        <span
          className="text-[11px] font-medium text-ink-600 tabular-nums"
          title="RateMyProfessors 'difficulty' — their scale, not ours"
        >
          Difficulty {fmt(difficulty)}
        </span>
      )}

      <span className="text-[11px] text-ink-400">{counts}</span>
    </span>
  );
}
