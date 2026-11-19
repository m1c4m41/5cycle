"use client";
import { useEffect, useState } from "react";
import {
  desktopEnabled,
  desktopSupported,
  requestDesktopPermission,
  setDesktopEnabled,
  showDesktopNotification,
} from "@/lib/alert-sound";

/** Desktop (browser) notifications for new seat alerts, kept per browser. */
export function DesktopToggle() {
  const [supported, setSupported] = useState(true);
  const [on, setOn] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    setSupported(desktopSupported());
    setOn(desktopEnabled());
    setDenied(desktopSupported() && Notification.permission === "denied");
  }, []);

  if (!supported)
    return <p className="text-xs text-ink-500">This browser doesn&rsquo;t support desktop notifications.</p>;

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          disabled={denied}
          onChange={async (e) => {
            if (e.target.checked) {
              const p = await requestDesktopPermission();
              if (p === "granted") {
                setDesktopEnabled(true);
                setOn(true);
                showDesktopNotification("5Cycle alerts are on", "You'll see a pop-up here when a seat opens.");
              } else {
                setDenied(p === "denied");
                setOn(false);
              }
            } else {
              setDesktopEnabled(false);
              setOn(false);
            }
          }}
          className="h-4 w-4 accent-brand-600"
        />
        🖥️ Show a desktop notification when a new alert arrives
      </label>
      {denied && (
        <span className="text-xs text-amber-800">
          Notifications are blocked for this site — allow them in your browser&rsquo;s site settings.
        </span>
      )}
    </div>
  );
}
