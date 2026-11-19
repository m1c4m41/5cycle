"use client";
/** Continuous scrolling: when this sentinel nears the viewport, load the next
 *  batch (the page re-renders with more rows, scroll position kept). The link is
 *  the fallback if JavaScript or IntersectionObserver is unavailable. */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function AutoLoadMore({ href, shown, total }: { href: string; shown: number; total: number }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          router.replace(href, { scroll: false });
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [href, router]);

  return (
    <div ref={ref} className="flex items-center justify-center gap-3 py-4 text-sm text-ink-500">
      <span>
        Showing {shown} of {total.toLocaleString()} · loading more…
      </span>
      <Link href={href} replace scroll={false} className="btn-secondary text-xs">
        Load more
      </Link>
    </div>
  );
}
