"use client";
/** Notes when the browser's back/forward button was used, so lists can put you back where you were. */
import { useEffect } from "react";

export function BackMarker() {
  useEffect(() => {
    const w = window as unknown as { __cycleBackAt?: number };
    const onPop = () => {
      w.__cycleBackAt = Date.now();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return null;
}
