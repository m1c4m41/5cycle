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
  changePasswordAction,
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
  // "Continue without an account" is the same form with intent=guest.
  if (fd.get("intent") === "guest") return guestStartForm(fd);
  const res = await signupAction(null, fd);
  if (res && !res.ok) redirect(`/signup?${errQuery(keep(fd), res.error ?? "Something went wrong.")}`);
  // Success path: signupAction already redirects to /planner?welcome=1.
}

/** "Continue without an account" on the signup page. */
export async function guestStartForm(fd: FormData): Promise<void> {
  const res = await guestStartAction(null, fd);
  if (res && !res.ok) redirect(`/signup?${errQuery(keep(fd), res.error ?? "Something went wrong.")}`);
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
