"use client";
/**
 * Infinite lists forget how far you scrolled when you open a row and come back.
 * This remembers the scroll position and how many rows were loaded (per URL, in
 * sessionStorage). On a back/forward arrival it reloads that many rows, then
 * scrolls to the saved spot. A normal visit (a nav link, a new search) still
 * starts at the top.
 */
import { useEffect, useRef } from "react";

type W = Window & { __cycleBackAt?: number; __listSeen?: boolean };

export function useListRestore(shown: number, restore: (target: number) => Promise<void>) {
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    const w = window as W;
    const key = `listpos:${location.pathname}${location.search}`;
    let saved: { y: number; shown: number } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {}
    const nav = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
    const back =
      Date.now() - (w.__cycleBackAt ?? 0) < 4000 || (!w.__listSeen && nav?.type === "back_forward");
    w.__listSeen = true;

    let active = true;
    let saving = !(back && saved && saved.y > 0);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (!saving) return;
      try {
        sessionStorage.setItem(key, JSON.stringify({ y: window.scrollY, shown: shownRef.current }));
      } catch {}
    };
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        save();
      }, 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);

    if (!saving && saved) {
      const { y, shown: target } = saved;
      (async () => {
        try {
          if (target > shownRef.current) await restoreRef.current(target);
        } catch {}
        if (!active) return;
        const go = () => window.scrollTo(0, y);
        requestAnimationFrame(() => requestAnimationFrame(go));
        setTimeout(go, 250);
        setTimeout(() => {
          go();
          saving = true;
        }, 600);
      })();
    }

    return () => {
      active = false;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
