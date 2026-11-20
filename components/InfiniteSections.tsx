"use client";
/** Continuous scroll: the first batch arrives with the page; further batches are
 *  fetched from a server action as the sentinel nears the viewport and appended,
 *  so everything already shown stays put (no re-fetch, no jump). */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadMoreSections } from "@/actions/catalog";
import { useListRestore } from "@/lib/use-list-restore";

export function InfiniteSections({
  first,
  firstCount,
  total,
  sp,
  term,
  batch = 40,
}: {
  first: ReactNode;
  firstCount: number;
  total: number;
  sp: Record<string, string>;
  term: string;
  batch?: number;
}) {
  const [chunks, setChunks] = useState<ReactNode[]>([]);
  const [shown, setShown] = useState(firstCount);
  const [error, setError] = useState(false);
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const done = shown >= total;

  const more = useCallback(async () => {
    if (loading.current || shown >= total) return;
    loading.current = true;
    try {
      const r = await loadMoreSections(sp, term, shown, batch);
      setChunks((c) => [...c, r.node]);
      setShown((n) => n + r.count);
      setError(false);
      if (r.count === 0) setShown(total); // nothing left (list changed underneath us)
    } catch {
      setError(true);
    } finally {
      loading.current = false;
    }
  }, [sp, term, shown, total, batch]);

  // Back from a class page: reload as many rows as were showing, then scroll to the saved spot.
  useListRestore(shown, async (target) => {
    loading.current = true;
    try {
      const nodes: ReactNode[] = [];
      let cur = firstCount;
      while (cur < Math.min(target, total)) {
        const r = await loadMoreSections(sp, term, cur, Math.min(100, target - cur));
        if (!r.count) break;
        nodes.push(r.node);
        cur += r.count;
      }
      if (nodes.length) {
        setChunks(nodes);
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
      <div className="flex flex-col gap-3">
        {first}
        {chunks.map((c, i) => (
          <div key={i} className="contents">
            {c}
          </div>
        ))}
      </div>
      {!done && (
        <div ref={sentinel} className="flex items-center justify-center gap-3 py-4 text-sm text-ink-500">
          <span>{error ? "Couldn’t load more." : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} · loading…`}</span>
          <button type="button" className="btn-secondary text-xs" onClick={() => { setError(false); void more(); }}>
            {error ? "Retry" : "Load more"}
          </button>
        </div>
      )}
      {done && total > 0 && (
        <p className="py-3 text-center text-xs text-ink-400">All {total.toLocaleString()} sections shown.</p>
      )}
    </>
  );
}
