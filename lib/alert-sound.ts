/** Short two-tone chime via WebAudio (no audio file). Browser-only. */
const KEY = "cycle_alert_sound";

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode — ignore */
  }
}

export function playAlertSound() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const tone = (freq: number, start: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + 0.4);
    };
    tone(880, 0);
    tone(1175, 0.18);
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch {
    /* blocked until the page has had a user gesture — fine */
  }
}

/* ---------------------------- desktop notifications ---------------------------- */

const DESKTOP_KEY = "cycle_alert_desktop";

export const desktopSupported = (): boolean => typeof window !== "undefined" && "Notification" in window;

/** On only when the browser has granted permission AND the student left it enabled. */
export function desktopEnabled(): boolean {
  if (!desktopSupported() || Notification.permission !== "granted") return false;
  try {
    return localStorage.getItem(DESKTOP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setDesktopEnabled(on: boolean) {
  try {
    localStorage.setItem(DESKTOP_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Ask the browser for permission (must be called from a click). */
export async function requestDesktopPermission(): Promise<NotificationPermission> {
  if (!desktopSupported()) return "denied";
  return Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
}

export function showDesktopNotification(title: string, body: string) {
  if (!desktopEnabled()) return;
  try {
    const n = new Notification(title, { body, tag: "5cycle-seat-alert", icon: "/icon.png" });
    n.onclick = () => {
      window.focus();
      window.location.href = "/notifications";
      n.close();
    };
  } catch {
    /* some mobile browsers only allow it from a service worker — skip */
  }
}
