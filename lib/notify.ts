/**
 * Seat-opening alerts. When a sync sees a full class gain a seat, every student
 * who ticked "Notify me when a spot opens" on it (while it is still Planned) gets an in-app notification and —
 * if they have a real email and mail is configured — an email.
 *
 * Classes that require a perm are never alerted: those seats are approved by the
 * instructor, not first-come, so "a spot opened" doesn't mean you can register.
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
  if (Number(after.perm_count) > 0 || Number(before.perm_count) > 0) return false;
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
      `SELECT e.user_id, u.email, u.school, s.code_string, s.title, s.id AS section_id
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
       JOIN sections s ON s.id = e.section_id
       WHERE s.perm_count = 0 AND e.section_id IN (${ph})
         AND (e.status = 'waitlist'  -- legacy status, still honoured
              OR (e.status = 'planned' AND EXISTS (
                    SELECT 1 FROM seat_alerts a WHERE a.user_id = e.user_id AND a.section_id = e.section_id)))`,
      chunk,
    );
    for (const w of waiters) {
      // One unread alert per class at a time.
      const dup = await get(
        "SELECT id FROM notifications WHERE user_id = ? AND section_id = ? AND kind = 'seat_open' AND read_at IS NULL",
        [w.user_id, w.section_id],
      );
      if (dup) continue;
      const registrar = SCHOOL_BY_CODE[w.school]?.registrarUrl ?? "";
      const title = `A seat opened in ${w.code_string}`;
      const body =
        `${w.code_string} — ${w.title} has an open seat. Seats go fast: register for it` +
        (registrar ? ` at your registrar (${registrar}).` : " at your registrar.");
      const id = newId("ntf-");
      await run(
        "INSERT INTO notifications(id, user_id, section_id, kind, title, body, created_at) VALUES(?,?,?,?,?,?,?)",
        [id, w.user_id, w.section_id, "seat_open", title, body, nowIso()],
      );
      sent++;
      // One-shot: the tick clears once the alert has gone out (re-tick if it fills again).
      await run("DELETE FROM seat_alerts WHERE user_id = ? AND section_id = ?", [w.user_id, w.section_id]);
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
