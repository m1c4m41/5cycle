"use client";
/** The header bell: unread badge that refreshes itself and chimes on a new alert. */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { playAlertSound, showDesktopNotification, soundEnabled } from "@/lib/alert-sound";

export function BellLink({ initialUnread, initialLatestId }: { initialUnread: number; initialLatestId: string | null }) {
  const [unread, setUnread] = useState(initialUnread);
  const lastId = useRef<string | null>(initialLatestId);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (document.hidden && !stop) {
        /* still poll when hidden so the chime fires when a tab is in the background */
      }
      try {
        const r = await fetch("/api/notifications", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { unread: number; latestId: string | null; latestTitle?: string; latestBody?: string };
        setUnread(j.unread);
        if (j.latestId && j.latestId !== lastId.current) {
          if (soundEnabled()) playAlertSound();
          showDesktopNotification(j.latestTitle ?? "A seat opened", j.latestBody ?? "Open 5Cycle to see which class.");
        }
        lastId.current = j.latestId;
      } catch {
        /* offline — try again next tick */
      }
    };
    const t = setInterval(poll, 30_000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stop = true;
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <Link
      href="/notifications"
      className="relative rounded-lg px-2 py-1.5 text-ink-600 hover:bg-ink-100"
      aria-label={unread ? `${unread} unread notifications` : "Notifications"}
      title="Seat alerts"
    >
      🔔
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-4 text-white">
          {unread}
        </span>
      )}
    </Link>
  );
}
