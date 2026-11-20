"use client";
/** Professors directory with continuous scroll: first batch comes with the page,
 *  the rest is fetched as the sentinel nears the viewport and appended. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadMoreProfessors } from "@/actions/professors";
import { useListRestore } from "@/lib/use-list-restore";

export function InfiniteProfessors({
  firstTrs,
  firstLis,
  firstCount,
  total,
  sp,
  ayLabel,
  ayTitle,
  batch = 40,
}: {
  firstTrs: ReactNode;
  firstLis: ReactNode;
  firstCount: number;
  total: number;
  sp: Record<string, string>;
  ayLabel: string;
  ayTitle: string;
  batch?: number;
}) {
  const [chunks, setChunks] = useState<{ trs: ReactNode; lis: ReactNode }[]>([]);
  const [shown, setShown] = useState(firstCount);
  const [error, setError] = useState(false);
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const done = shown >= total;

  const more = useCallback(async () => {
    if (loading.current || shown >= total) return;
    loading.current = true;
    try {
      const r = await loadMoreProfessors(sp, shown, batch);
      setChunks((c) => [...c, { trs: r.trs, lis: r.lis }]);
      setShown((n) => (r.count === 0 ? total : n + r.count));
      setError(false);
    } catch {
      setError(true);
    } finally {
      loading.current = false;
    }
  }, [sp, shown, total, batch]);

  useListRestore(shown, async (target) => {
    loading.current = true;
    try {
      const got: { trs: ReactNode; lis: ReactNode }[] = [];
      let cur = firstCount;
      while (cur < Math.min(target, total)) {
        const r = await loadMoreProfessors(sp, cur, Math.min(100, target - cur));
        if (!r.count) break;
        got.push({ trs: r.trs, lis: r.lis });
        cur += r.count;
      }
      if (got.length) {
        setChunks(got);
        setShown(cur);
      }
    } finally {
      loading.current = false;
    }
  });

  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && more(), {
      rootMargin: "1200px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [more, done, error]);

  return (
    <>
      {/* table on sm and up */}
      <div className="card hidden overflow-hidden sm:block">
        {/* Fixed layout: column widths come from the colgroup, so every batch looks the same. */}
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[18%]" />
            <col className="w-[11%]" />
            <col className="w-[27%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50 text-left text-[11px] uppercase tracking-wide text-ink-500">
              <th className="px-4 py-2.5 font-semibold">Professor</th>
              <th className="px-2 py-2.5 font-semibold">Campus</th>
              <th className="px-2 py-2.5 text-right font-semibold" title={ayTitle}>
                Sections <span className="font-normal normal-case text-ink-400">{ayLabel}</span>
              </th>
              <th className="px-2 py-2.5 font-semibold">Our students</th>
              <th className="px-2 py-2.5 font-semibold">Review</th>
              <th className="px-4 py-2.5 font-semibold">RateMyProfessors</th>
            </tr>
          </thead>
          <tbody>
            {firstTrs}
            {chunks.map((c, i) => (
              <FragmentKeyed key={i}>{c.trs}</FragmentKeyed>
            ))}
          </tbody>
        </table>
      </div>

      {/* stacked cards below sm */}
      <ul className="space-y-3 sm:hidden">
        {firstLis}
        {chunks.map((c, i) => (
          <FragmentKeyed key={i}>{c.lis}</FragmentKeyed>
        ))}
      </ul>

      {!done && (
        <div ref={sentinel} className="flex items-center justify-center gap-3 py-4 text-sm text-ink-500">
          <span>{error ? "Couldn’t load more." : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} · loading…`}</span>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => {
              setError(false);
              void more();
            }}
          >
            {error ? "Retry" : "Load more"}
          </button>
        </div>
      )}
      {done && total > 0 && (
        <p className="py-3 text-center text-xs text-ink-400">All {total.toLocaleString()} professors shown.</p>
      )}
    </>
  );
}

function FragmentKeyed({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
