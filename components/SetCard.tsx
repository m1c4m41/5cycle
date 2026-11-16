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
      if (ref.current && window.location.hash === `#${id}`) ref.current.open = true;
    };
    openIfTargeted();
    window.addEventListener("hashchange", openIfTargeted);
    return () => window.removeEventListener("hashchange", openIfTargeted);
  }, [id]);

  return (
    <details ref={ref} id={id} className="group card card-pad">
      <summary className="flex cursor-pointer list-none items-center gap-2 select-none [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">{header}</div>
        <span
          aria-hidden
          className="shrink-0 text-sm text-ink-400 transition-transform duration-150 group-open:rotate-90"
        >
          ▸
        </span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
