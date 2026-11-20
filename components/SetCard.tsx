"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * One requirement set (major / minor / GE) as a collapsible card.
 *
 * Closed by default so the checklist opens compact — the user expands only
 * the set they care about. The quick-jump chips in the progress summary
 * link to `#set-<id>`; clicking one (or landing on the page with that hash)
 * opens the matching card.
 */
export function SetCard({
  id,
  header,
  children,
}: {
  id: string;
  header: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const openIfTargeted = () => {
      if (!ref.current) return;
      // Opened by a #set-… link, or by ?open=set-… (what a form action redirects back with).
      if (window.location.hash === `#${id}` || new URLSearchParams(window.location.search).get("open") === id)
        ref.current.open = true;
    };
    openIfTargeted();
    window.addEventListener("hashchange", openIfTargeted);
    return () => window.removeEventListener("hashchange", openIfTargeted);
  }, [id]);

  return (
    <details ref={ref} id={id} className="group card card-pad">
      <summary className="flex cursor-pointer list-none items-center gap-3 select-none [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">{header}</div>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs font-semibold text-ink-500 group-open:hidden">Expand</span>
          <span className="hidden text-xs font-semibold text-ink-500 group-open:inline">Collapse</span>
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 shadow-sm transition-transform duration-150 group-open:rotate-180"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
