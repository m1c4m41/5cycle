"use client";
/**
 * Keeps the catalog search/filters reachable while scrolling: once the bar has
 * scrolled out of view it docks under the site header, tucked away. Moving the
 * cursor to the top edge (or tapping the tab) slides it out; it tucks back when
 * the cursor leaves — unless a field inside has focus.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function AutoHideBar({ children }: { children: ReactNode }) {
  const spacer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(57);
  const [h, setH] = useState<number | undefined>();

  useEffect(() => {
    const update = () => {
      const header = document.querySelector("header");
      setTop(header ? Math.round(header.getBoundingClientRect().height) : 57);
      const sp = spacer.current;
      if (!sp) return;
      if (!docked && panel.current) setH(panel.current.offsetHeight);
      const bottom = sp.getBoundingClientRect().bottom;
      const next = bottom < (header?.getBoundingClientRect().height ?? 57);
      setDocked((d) => (d === next ? d : next));
      if (!next) setOpen(false);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [docked]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    cancel();
    setOpen(true);
  };
  // Short grace period so a slight cursor drift doesn't snap it shut.
  const close = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      setOpen(false);
    }, 250);
  }, []);

  return (
    <div ref={spacer} style={docked && h ? { height: h } : undefined}>
      {docked && (
        <button
          type="button"
          onMouseEnter={show}
          onClick={() => (open ? setOpen(false) : show())}
          className="fixed left-1/2 z-20 -translate-x-1/2 rounded-b-lg border border-t-0 border-ink-200 bg-white px-3 py-0.5 text-[11px] font-semibold text-ink-500 shadow-sm hover:text-ink-800"
          style={{ top }}
          aria-expanded={open}
        >
          ▾ Search &amp; filters
        </button>
      )}
      {docked && <div className="fixed inset-x-0 z-10 h-2" style={{ top }} onMouseEnter={show} />}
      <div
        ref={panel}
        onMouseEnter={docked ? cancel : undefined}
        onMouseLeave={docked ? close : undefined}
        onBlur={docked ? close : undefined}
        className={
          docked
            ? "fixed inset-x-0 z-20 max-h-[calc(100vh-4rem)] overflow-y-auto bg-white/95 shadow-lg backdrop-blur will-change-transform"
            : undefined
        }
        style={
          docked
            ? {
                top,
                transform: open ? "translateY(0)" : "translateY(-100%)",
                opacity: open ? 1 : 0,
                visibility: open ? "visible" : "hidden",
                pointerEvents: open ? "auto" : "none",
                transition: open
                  ? "transform 320ms cubic-bezier(0.22,1,0.36,1), opacity 200ms ease-out"
                  : "transform 380ms cubic-bezier(0.4,0,0.2,1), opacity 380ms ease-in, visibility 0s linear 380ms",
              }
            : undefined
        }
      >
        <div className={docked ? "mx-auto max-w-7xl px-4 py-2 sm:px-6" : undefined}>{children}</div>
      </div>
    </div>
  );
}
