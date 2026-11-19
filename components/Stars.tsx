import Link from "next/link";

/**
 * Star display. Server-renderable, used in catalog cards, section pages,
 * professor pages and the planner. Pass `href` to make the stars a link (e.g.
 * to the professor's review page) — clicking the stars then opens the written
 * reviews, not just a number.
 */
export function Stars({
  value,
  size = 14,
  title,
  href,
  hideEmpty = false,
}: {
  value: number | null | undefined;
  size?: number;
  title?: string;
  /** Internal route — renders the stars as a link (e.g. to #reviews). */
  href?: string;
  /** Show nothing (instead of "— unrated") when there is no rating. */
  hideEmpty?: boolean;
}) {
  if (hideEmpty && (value === null || value === undefined || Number.isNaN(value))) return null;
  const display =
    value === null || value === undefined || Number.isNaN(value) ? (
      <span className="text-[11px] font-medium text-ink-400" title={title ?? "No ratings yet"}>
        — unrated
      </span>
    ) : (
      <span className="inline-flex items-center gap-1">
        <span className="relative inline-block leading-none" style={{ fontSize: size }}>
          <span className="text-ink-300">★★★★★</span>
          <span
            className="absolute inset-0 overflow-hidden whitespace-nowrap text-amber-500"
            style={{ width: `${Math.max(0, Math.min(100, (value / 5) * 100))}%` }}
          >
            ★★★★★
          </span>
        </span>
        <span className="text-xs font-semibold text-ink-700 tabular-nums">
          {value.toFixed(1)}
        </span>
      </span>
    );

  if (!href) {
    return (
      <span
        className="inline-flex items-center align-middle"
        title={title}
        aria-label={
          value === null || value === undefined || Number.isNaN(value)
            ? "No ratings yet"
            : `${value.toFixed(1)} out of 5 stars`
        }
      >
        {display}
      </span>
    );
  }

  return (
    <Link
      href={href}
      className="inline-flex items-center align-middle rounded hover:opacity-75"
      title={title ?? "View written reviews"}
      aria-label={
        value === null || value === undefined || Number.isNaN(value)
          ? "No ratings yet — view reviews"
          : `${value.toFixed(1)} out of 5 stars — view written reviews`
      }
    >
      {display}
    </Link>
  );
}
