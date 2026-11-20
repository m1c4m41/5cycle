"use server";

/**
 * Plain-<form> adapters for the account actions in `actions/auth.ts`.
 *
 * The actions in auth.ts were written for `useActionState`, so they take
 * `(prevState, formData)`. A server component rendering
 * `<form action={fn}>` passes FormData as the *first* argument, which would be
 * read as prevState and silently break every field. Each wrapper below calls
 * the real action with `null` state, then bounces failures back to the owning
 * page as a query string: the message in `err` plus whatever the user typed in
 * `keep_*` params so the server-rendered form can restore itself.
 *
 * Secret fields (`password`, `current`, `next` on the password form) are never
 * echoed back into a URL.
 */
import { redirect } from "next/navigation";
import {
  cancelEmailChangeAction,
  changePasswordAction,
  requestEmailChangeAction,
  resendVerificationAction,
  setNotifyEmailAction,
  verifyEmailChangeAction,
  clearSamplePlanAction,
  guestStartAction,
  loginAction,
  upgradeGuestAction,
  seedSamplePlanAction,
  signupAction,
  updateProfileAction,
  wipeAccountAction,
} from "./auth";
import { currentUser } from "@/lib/session";

/** Typed values worth putting back in the form, prefixed so they can't collide. */
function keep(fd: FormData, prefix = "keep_"): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string" && v.trim()) q.set(prefix + k, v);
  }
  return q;
}

/** `?err=…` appended to whatever the form should keep. */
function errQuery(q: URLSearchParams, error: string): string {
  q.set("err", error);
  return q.toString();
}

function errOnly(error: string): string {
  return `err=${encodeURIComponent(error)}`;
}

function okQuery(notice: string): string {
  return `ok=${encodeURIComponent(notice)}`;
}

/** These all mutate account data; send guests to the sign-in page first. */
async function ensureSignedIn(): Promise<void> {
  const user = await currentUser();
  if (!user) redirect(`/login?${errOnly("Sign in before changing your account settings.")}`);
}

/* ------------------------------- accounts ------------------------------- */

export async function signupForm(fd: FormData): Promise<void> {
  const res = await signupAction(null, fd);
  if (res && !res.ok) redirect(`/signup?${errQuery(keep(fd), res.error ?? "Something went wrong.")}`);
  // Success path: signupAction already redirects to /planner?welcome=1.
}

/** "Continue without an account" on the signup page. */
export async function guestStartForm(fd: FormData): Promise<void> {
  const res = await guestStartAction(null, fd);
  if (res && !res.ok) {
    const q = keep(fd);
    q.delete("keep_ack");
    for (const k of ["next", "add", "force"]) {
      const v = fd.get(k);
      if (typeof v === "string" && v) q.set(k, v);
    }
    redirect(`/guest?${errQuery(q, res.error ?? "Something went wrong.")}`);
  }
}

export async function upgradeGuestForm(fd: FormData): Promise<void> {
  const res = await upgradeGuestAction(null, fd);
  if (res?.ok) redirect(`/profile?${okQuery(res.notice ?? "Account created.")}`);
  const q = new URLSearchParams();
  const name = fd.get("name");
  const email = fd.get("email");
  if (typeof name === "string" && name.trim()) q.set("keep_name", name.trim());
  if (typeof email === "string" && email.trim()) q.set("keep_email", email.trim());
  redirect(`/profile?${errQuery(q, res?.error ?? "Could not create the account.")}`);
}

export async function loginForm(fd: FormData): Promise<void> {
  const res = await loginAction(null, fd);
  if (res && !res.ok) {
    // Only the email is restored — never the password.
    const q = new URLSearchParams();
    const email = fd.get("email");
    if (typeof email === "string" && email.trim()) q.set("keep_email", email.trim());
    const next = fd.get("next");
    if (typeof next === "string" && next.startsWith("/")) q.set("next", next);
    redirect(`/login?${errQuery(q, res.error ?? "Something went wrong.")}`);
  }
  // Success path: loginAction redirects to the `next` field or /planner.
}

/* -------------------------------- profile ------------------------------- */

export async function updateProfileForm(fd: FormData) {
  await ensureSignedIn();
  const res = await updateProfileAction(null, fd);
  if (res?.ok) redirect(`/profile?${okQuery(res.notice ?? "Profile saved.")}`);
  redirect(`/profile?${errQuery(keep(fd), res?.error ?? "Profile was not saved.")}`);
}

export async function changePasswordForm(fd: FormData) {
  await ensureSignedIn();
  const res = await changePasswordAction(null, fd);
  // `current` and `next` are both passwords: nothing is restored on failure.
  if (res?.ok) redirect(`/profile?${okQuery(res.notice ?? "Password changed.")}`);
  redirect(`/profile?${errOnly(res?.error ?? "Password was not changed.")}`);
}

/* ------------------------------ sample plan ----------------------------- */

export async function seedSamplePlanForm(fd: FormData) {
  await ensureSignedIn();
  const res = await seedSamplePlanAction(null, fd);
  if (res?.ok) redirect(`/profile?${okQuery(res.notice ?? "Sample plan added.")}`);
  redirect(`/profile?${errQuery(keep(fd), res?.error ?? "No sample courses were added.")}`);
}

export async function clearSamplePlanForm() {
  await ensureSignedIn();
  const res = await clearSamplePlanAction();
  if (res?.ok) redirect(`/profile?${okQuery(res.notice ?? "Sample courses removed.")}`);
  redirect(`/profile?${errOnly(res?.error ?? "Sample courses were not removed.")}`);
}

/* ------------------------------ danger zone ----------------------------- */

export async function wipeAccountForm(fd: FormData): Promise<void> {
  await ensureSignedIn();
  const res = await wipeAccountAction(null, fd);
  if (res && !res.ok) redirect(`/profile?${errOnly(res.error ?? "Account was not deleted.")}`);
  // Success path: wipeAccountAction ends the session and redirects to "/".
}

/* ------------------------------ change email ------------------------------ */

export async function requestEmailChangeForm(fd: FormData) {
  await ensureSignedIn();
  const res = await requestEmailChangeAction(null, fd);
  if (res?.ok) redirect(`/profile?${okQuery(res.notice ?? "Code sent.")}#change-email`);
  const q = new URLSearchParams();
  const em = fd.get("email");
  if (typeof em === "string" && em.trim()) q.set("keep_newemail", em.trim());
  redirect(`/profile?${errQuery(q, res?.error ?? "Couldn't send the code.")}#change-email`);
}

export async function verifyEmailChangeForm(fd: FormData) {
  await ensureSignedIn();
  const res = await verifyEmailChangeAction(null, fd);
  if (res?.ok) redirect(`/profile?${okQuery(res.notice ?? "Email changed.")}`);
  redirect(`/profile?${errOnly(res?.error ?? "Email was not changed.")}#change-email`);
}

export async function cancelEmailChangeForm() {
  await ensureSignedIn();
  await cancelEmailChangeAction();
  redirect("/profile#change-email");
}

/** Code entry on /verify-email (right after signup). */
export async function verifySignupEmailForm(fd: FormData) {
  await ensureSignedIn();
  const next = String(fd.get("next") ?? "/planner");
  const dest = next.startsWith("/") && !next.startsWith("//") ? next : "/planner";
  const res = await verifyEmailChangeAction(null, fd);
  if (res?.ok) redirect(dest);
  redirect(`/verify-email?next=${encodeURIComponent(dest)}&err=${encodeURIComponent(res?.error ?? "Couldn't verify.")}`);
}

export async function resendSignupCodeForm(fd: FormData) {
  await ensureSignedIn();
  const next = String(fd.get("next") ?? "/planner");
  const dest = next.startsWith("/") && !next.startsWith("//") ? next : "/planner";
  const res = await resendVerificationAction();
  redirect(`/verify-email?next=${encodeURIComponent(dest)}&${res.ok ? "ok=" + encodeURIComponent("New code sent.") : errOnly(res.error ?? "Couldn't send.")}`);
}

export async function setNotifyEmailForm(fd: FormData) {
  await ensureSignedIn();
  await setNotifyEmailAction(fd);
  redirect(`/profile?${okQuery("Email alert setting saved.")}#change-email`);
}
