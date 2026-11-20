"use client";
/** Light / dark slider with ☀️ and 🌙 on either side. The choice is remembered in this browser; until it is made, the system setting applies. */
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);
  const set = (next: boolean) => {
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem("5c-theme", next ? "dark" : "light");
    } catch {}
    setDark(next);
  };
  return (
    <div className="flex items-center gap-1.5" title={dark ? "Dark mode" : "Light mode"}>
      <button
        type="button"
        onClick={() => set(false)}
        aria-label="Light mode"
        className={`text-sm leading-none transition-opacity ${dark ? "opacity-40 hover:opacity-80" : "opacity-100"}`}
      >
        <span aria-hidden>☀️</span>
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label="Dark mode"
        onClick={() => set(!dark)}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 ${
          dark ? "border-brand-500 bg-brand-600" : "border-ink-300 bg-ink-200"
        }`}
      >
        <span
          aria-hidden
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all ${dark ? "left-[1.1rem]" : "left-0.5"}`}
        />
      </button>
      <button
        type="button"
        onClick={() => set(true)}
        aria-label="Dark mode"
        className={`text-sm leading-none transition-opacity ${dark ? "opacity-100" : "opacity-40 hover:opacity-80"}`}
      >
        <span aria-hidden>🌙</span>
      </button>
    </div>
  );
}
