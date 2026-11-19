/**
 * Seat-opening alerts. When a sync sees a full class gain a seat, every student
 * who ticked "Notify me when a spot opens" on it (while it is Planned or Perm requested) gets an in-app notification and —
 * if they have a real email and mail is configured — an email.
 *
 * The tick is available while the class is Planned or Perm requested, and ends
 * once it is marked Registered.
 */
import { all, get, newId, nowIso, run } from "./db";
import { SCHOOL_BY_CODE } from "./constants";
// (not imported from ./session: this module also runs in the sync CLI, which can
// not pull in next/headers)
const isGuestEmail = (email: string) => email.endsWith("@guest.local");

export type SeatSnapshot = { seats_total: number; seats_filled: number; perm_count: number };

const isFull = (s: SeatSnapshot) => s.seats_total > 0 && s.seats_filled >= s.seats_total;
const hasRoom = (s: SeatSnapshot) => s.seats_total > 0 && s.seats_filled < s.seats_total;

/** Did this section go from full to having a seat — and is it a normal (no-perm) class? */
export function seatOpened(before: SeatSnapshot, after: SeatSnapshot): boolean {
  return isFull(before) && hasRoom(after);
}

type Waiter = {
  user_id: string;
  email: string;
  school: string;
  code_string: string;
  title: string;
  section_id: string;
};

export async function notifyOpenings(sectionIds: string[]): Promise<number> {
  if (sectionIds.length === 0) return 0;
  let sent = 0;
  for (let i = 0; i < sectionIds.length; i += 200) {
    const chunk = sectionIds.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const waiters = await all<Waiter>(
      `SELECT e.user_id, u.email, u.school, s.code_string, s.title, s.id AS section_id,
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
       JOIN sections s ON s.id = e.section_id
       WHERE e.section_id IN (${ph})
         AND (e.status = 'waitlist'  -- legacy status, still honoured
              OR (e.status IN ('planned', 'perm_requested') AND EXISTS (
                    SELECT 1 FROM seat_alerts a WHERE a.user_id = e.user_id AND a.section_id = e.section_id)))`,
      chunk,
    );
    for (const w of waiters) {
      // Every opening gets its own alert (with its own timestamp), read or not.
      const registrar = SCHOOL_BY_CODE[w.school]?.registrarUrl ?? "";
      const title = `A seat opened in ${w.code_string}`;
      const when = new Date().toISOString().replace("T", " ").slice(0, 16);
      const body =
        `${w.code_string} — ${w.title} opened up at ${when} UTC. Seats go fast: register for it` +
        (registrar ? ` at your registrar (${registrar}).` : " at your registrar.");
      const id = newId("ntf-");
      await run(
        "INSERT INTO notifications(id, user_id, section_id, kind, title, body, created_at) VALUES(?,?,?,?,?,?,?)",
        [id, w.user_id, w.section_id, "seat_open", title, body, nowIso()],
      );
      sent++;
      // The tick stays on: alerts keep coming each time the class fills and reopens,
      // until the student changes the status (Registered / Perm requested) or unticks it.
      if (!isGuestEmail(w.email) && (await sendEmail(w.email, title, body))) {
        await run("UPDATE notifications SET emailed_at = ? WHERE id = ?", [nowIso(), id]);
      }
    }
  }
  return sent;
}

/** Email through Resend when RESEND_API_KEY (and MAIL_FROM) are set; otherwise a no-op. */
async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function alertSectionIds(userId: string): Promise<Set<string>> {
  const rows = await all<{ section_id: string }>("SELECT section_id FROM seat_alerts WHERE user_id = ?", [userId]);
  return new Set(rows.map((r) => r.section_id));
}

export async function setSeatAlert(userId: string, sectionId: string, on: boolean): Promise<void> {
  if (on) {
    await run("INSERT OR IGNORE INTO seat_alerts(user_id, section_id, created_at) VALUES(?,?,?)", [userId, sectionId, nowIso()]);
  } else {
    await run("DELETE FROM seat_alerts WHERE user_id = ? AND section_id = ?", [userId, sectionId]);
  }
}

export async function unreadCount(userId: string): Promise<number> {
  const r = await get<{ n: number }>(
    "SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL",
    [userId],
  );
  return Number(r?.n ?? 0);
}

export async function latestUnreadId(userId: string): Promise<string | null> {
  const r = await get<{ id: string }>(
    "SELECT id FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [userId],
  );
  return r?.id ?? null;
}

export type NotificationRow = {
  id: string;
  section_id: string | null;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

export async function listNotifications(userId: string, limit = 50): Promise<NotificationRow[]> {
  return all<NotificationRow>(
    "SELECT id, section_id, kind, title, body, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    [userId, limit],
  );
}

export async function markAllRead(userId: string): Promise<void> {
  await run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [nowIso(), userId]);
}
