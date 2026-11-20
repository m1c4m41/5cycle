"use server";
/** Forgot password: email a 6-digit code, then let the student set a new password. */
import crypto from "node:crypto";
import { redirect } from "next/navigation";
import { get, nowIso, run } from "@/lib/db";
import { mailConfigured, sendEmail } from "@/lib/notify";
import { hashPassword } from "@/lib/session";
import { assertActionsEnabled, formStr } from "@/lib/server";

const TTL_MS = 10 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const hashCode = (c: string) => crypto.createHash("sha256").update(c).digest("hex");
const enc = encodeURIComponent;

/** Step 1. Always answers the same way so it can't be used to find out who has an account. */
export async function requestResetForm(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const email = formStr(fd, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    redirect(`/forgot-password?err=${enc("Enter a valid email address.")}`);
  if (!mailConfigured())
    redirect(`/forgot-password?err=${enc("Email sending isn't set up on this site yet, so a reset code can't be sent.")}&keep_email=${enc(email)}`);

  const user = await get<{ id: string }>("SELECT id FROM users WHERE lower(email) = ? AND email NOT LIKE '%@guest.local'", [email]);
  const prev = await get<{ created_at: string }>("SELECT created_at FROM password_resets WHERE email = ?", [email]);
  if (user && !(prev && Date.now() - Date.parse(prev.created_at) < RESEND_WAIT_MS)) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const sent = await sendEmail(
      email,
      "Reset your 5Cycle password",
      `Your 5Cycle password reset code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask to reset your password, ignore this message — your password is unchanged.`,
    );
    if (sent) {
      await run(
        `INSERT INTO password_resets(email, code_hash, attempts, expires_at, created_at) VALUES(?,?,0,?,?)
         ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, attempts=0,
           expires_at=excluded.expires_at, created_at=excluded.created_at`,
        [email, hashCode(code), new Date(Date.now() + TTL_MS).toISOString(), nowIso()],
      );
    }
  }
  redirect(`/reset-password?email=${enc(email)}&ok=${enc("If that email has an account, we sent a 6-digit code to it.")}`);
}

/** Step 2: code + new password + confirmation. */
export async function resetPasswordForm(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const email = formStr(fd, "email").toLowerCase();
  const back = (msg: string) => redirect(`/reset-password?email=${enc(email)}&err=${enc(msg)}`);
  const code = formStr(fd, "code").replace(/\D/g, "");
  const next = formStr(fd, "next");
  const confirm = formStr(fd, "confirm");
  if (next.length < 8) back("New password must be 8+ characters.");
  if (next !== confirm) back("The two passwords don't match.");

  const pend = await get<{ code_hash: string; attempts: number; expires_at: string }>(
    "SELECT code_hash, attempts, expires_at FROM password_resets WHERE email = ?",
    [email],
  );
  if (!pend) back("That code isn't valid. Request a new one.");
  if (pend && Date.parse(pend.expires_at) < Date.now()) {
    await run("DELETE FROM password_resets WHERE email = ?", [email]);
    back("That code expired. Request a new one.");
  }
  if (pend && pend.attempts >= MAX_ATTEMPTS) {
    await run("DELETE FROM password_resets WHERE email = ?", [email]);
    back("Too many wrong tries. Request a new code.");
  }
  if (pend && hashCode(code) !== pend.code_hash) {
    await run("UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?", [email]);
    back("That code isn't right.");
  }
  const user = await get<{ id: string }>("SELECT id FROM users WHERE lower(email) = ?", [email]);
  if (!user) back("That code isn't valid. Request a new one.");
  if (user) {
    await run("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", [
      hashPassword(next),
      nowIso(),
      user.id,
    ]);
    // Anyone holding an old session (a stolen laptop, say) is signed out.
    await run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
  }
  await run("DELETE FROM password_resets WHERE email = ?", [email]);
  redirect(`/login?ok=${enc("Password changed. Sign in with your new password.")}&keep_email=${enc(email)}`);
}
