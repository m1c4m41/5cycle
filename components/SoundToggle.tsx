"use client";
import { useEffect, useState } from "react";
import { playAlertSound, setSoundEnabled, soundEnabled } from "@/lib/alert-sound";

/** Sound on/off for new alerts (kept in this browser) + a test button. */
export function SoundToggle() {
  const [on, setOn] = useState(true);
  useEffect(() => setOn(soundEnabled()), []);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setSoundEnabled(e.target.checked);
            if (e.target.checked) playAlertSound();
          }}
          className="h-4 w-4 accent-brand-600"
        />
        🔊 Play a sound when a new alert arrives
      </label>
      <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={playAlertSound}>
        Test sound
      </button>
    </div>
  );
}
