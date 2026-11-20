"use server";
/**
 * Server Actions — accounts, profile, sample-plan seeding, account deletion.
 *
 * Every mutation the UI performs is a Server Action bound to a <form>. Nothing
 * in app/ fetches /api/* from the browser; those routes stay for scripted use.
 *
 * The "use server" directive above is load-bearing: components/Nav.tsx passes
 * logoutAction straight to a <form action={...}>, and without the directive it
 * serialises as a plain function — which throws while rendering *every* page
 * for any signed-in user.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  checkCredentials,
  createGuest,
  createUser,
  currentUser,
  endSession,
  isGuestUser,
  startGuestSession,
  upgradeGuest,
  hashPassword,
  startSession,
  updateUserProfile,
  verifyPassword,
} from "@/lib/session";
import crypto from "node:crypto";
import { get, nowIso, run, tx } from "@/lib/db";
import { mailConfigured, sendEmail } from "@/lib/notify";
import { listSets, pruneAssignments } from "@/lib/requirements";
import { inferSchoolFromEmail } from "@/lib/util";
import { applySamplePlan, buildSamplePlan } from "@/lib/sample";
import { addToSchedule } from "@/lib/schedule";
import { currentTermId } from "@/lib/ingest";
import { SCHOOL_BY_CODE, type SchoolCode } from "@/lib/constants";
import { TRACK_IDS } from "@/lib/prehealth";
import {
  assertActionsEnabled,
  formNum,
  formStr,
  IDLE,
  revalidateSchedule,
  safeNext,
  userOrRedirect,
  type ActionState,
} from "@/lib/server";

/** The pre-health track chosen on a form, or null. Only real track ids are kept. */
function trackIdFrom(fd: FormData): string | null {
  const t = formStr(fd, "trackId");
  return TRACK_IDS.includes(t) ? t : null;
}

function revalidateAll() {
  revalidatePath("/", "layout");
  revalidateSchedule();
}

/* ------------------------------- signup -------------------------------- */

export async function signupAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const email = formStr(fd, "email").toLowerCase();
  // School email reveals the home campus — use it when the field is blank.
  let school = formStr(fd, "school").toUpperCase();
  if (!SCHOOL_BY_CODE[school]) school = inferSchoolFromEmail(email) ?? "";
  if (!SCHOOL_BY_CODE[school]) {
    return {
      ok: false,
      error:
        "Choose your home campus — or use your school email (@pomona.edu, @cmc.edu, " +
        "@scrippscollege.edu, @pitzer.edu, @harvey-mudd.edu) and it is picked for you.",
    };
  }

  // A no-account visitor signing up keeps everything they've saved.
  const me = await currentUser();
  if (me && isGuestUser(me)) {
    const up = await upgradeGuest(me.id, {
      name: formStr(fd, "name"),
      email: formStr(fd, "email"),
      password: formStr(fd, "password"),
    });
    if (!up.ok) return { ok: false, error: up.error };
    await updateUserProfile(me.id, {
      school: school as SchoolCode,
      grad_year: formNum(fd, "gradYear"),
      major_id: formStr(fd, "majorId") || null,
      major2_id: formStr(fd, "major2Id") || null,
      minor_id: formStr(fd, "minorId") || null,
      track_id: trackIdFrom(fd),
    });
    await pruneAssignments(
      me.id,
      [`ge-${school}`, formStr(fd, "majorId"), formStr(fd, "major2Id"), formStr(fd, "minorId"), trackIdFrom(fd)].filter(Boolean) as string[],
    );
    await run("UPDATE users SET notify_email = ? WHERE id = ?", [fd.get("notifyEmail") ? 1 : 0, me.id]);
    const pendingUp = await applyPendingAdd(me.id, fd);
    revalidateAll();
    return verifyThenGo(me.id, formStr(fd, "email").toLowerCase(), withNotice(safeNext(formStr(fd, "next"), "/planner"), pendingUp));
  }

  const res = await createUser({
    name: formStr(fd, "name"),
    email: formStr(fd, "email"),
    password: formStr(fd, "password"),
    school,
    gradYear: formNum(fd, "gradYear"),
    majorId: formStr(fd, "majorId") || null,
    major2Id: formStr(fd, "major2Id") || null,
    minorId: formStr(fd, "minorId") || null,
    trackId: trackIdFrom(fd),
  });
  if (!res.ok) return { ok: false, error: res.error };

  await startSession(res.id);
  await run("UPDATE users SET notify_email = ? WHERE id = ?", [fd.get("notifyEmail") ? 1 : 0, res.id]);
  const pending = await applyPendingAdd(res.id, fd);
  revalidateAll();
  const url = new URL(safeNext(formStr(fd, "next"), "/planner"), "http://internal");
  url.searchParams.set("welcome", "1");
  if (pending !== null) {
    if (pending.ok) url.searchParams.set("ok", pending.notice ?? "");
    else url.searchParams.set("err", pending.error ?? "");
  }
  return verifyThenGo(res.id, formStr(fd, "email").toLowerCase(), url.pathname + url.search);
}

/* --------------------------- no-account start --------------------------- */

/**
 * Use the site without an account: pick a campus and program, and the plan is
 * kept for this browser (a year-long cookie). It can be turned into a real
 * account later from the profile page without losing anything.
 */
export async function guestStartAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const school = formStr(fd, "school").toUpperCase();
  if (!SCHOOL_BY_CODE[school]) return { ok: false, error: "Choose your home campus to start." };
  if (formStr(fd, "ack") !== "1")
    return {
      ok: false,
      error:
        "Tick “I understand” first: without an account your data stays in this browser, can’t sync to other devices, and can be lost if you clear your browsing history.",
    };
  const existing = await currentUser();
  if (existing) redirect(safeNext(formStr(fd, "next"), "/planner"));

  const id = await createGuest({
    name: formStr(fd, "name") || undefined,
    school,
    gradYear: formNum(fd, "gradYear"),
    majorId: formStr(fd, "majorId") || null,
    major2Id: formStr(fd, "major2Id") || null,
    minorId: formStr(fd, "minorId") || null,
    trackId: trackIdFrom(fd),
  });
  await startGuestSession(id);
  const pending = await applyPendingAdd(id, fd);
  revalidateAll();
  const url = new URL(safeNext(formStr(fd, "next"), "/planner"), "http://internal");
  if (pending !== null) {
    if (pending.ok) url.searchParams.set("ok", pending.notice ?? "");
    else url.searchParams.set("err", pending.error ?? "");
  }
  redirect(url.pathname + url.search);
}

/** Guest → full account, in place. Form fields: name, email, password. */
export async function upgradeGuestAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  if (!isGuestUser(user)) return { ok: false, error: "This is already a full account." };
  const res = await upgradeGuest(user.id, {
    name: formStr(fd, "name"),
    email: formStr(fd, "email"),
    password: formStr(fd, "password"),
  });
  if (!res.ok) return { ok: false, error: res.error };
  await run("UPDATE users SET notify_email = ? WHERE id = ?", [fd.get("notifyEmail") ? 1 : 0, user.id]);
  const sent = await issueEmailCode(user.id, formStr(fd, "email").toLowerCase());
  revalidateAll();
  return {
    ok: true,
    notice:
      "Account created — your plan is now saved to your email and works on any device." +
      (sent.ok ? " We emailed you a code: enter it under Email below to verify." : ""),
  };
}

/* -------------------------------- login -------------------------------- */

export async function loginAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const email = formStr(fd, "email");
  const password = formStr(fd, "password");
  if (!email || !password) return { ok: false, error: "Email and password are required." };

  const res = await checkCredentials(email, password);
  if (!res.ok) return { ok: false, error: "Those credentials don't match an account." };

  await startSession(res.id);
  const pending = await applyPendingAdd(res.id, fd);
  revalidateAll();
  redirect(withNotice(safeNext(formStr(fd, "next"), "/planner"), pending));
}

/**
 * If the form carries a pending course add (a guest's "Add to plan" bounced
 * through sign-in), complete it for the fresh session and report the result.
 */
async function applyPendingAdd(userId: string, fd: FormData): Promise<ActionState> {
  const sectionId = formStr(fd, "add");
  if (!sectionId) return IDLE;
  const res = await addToSchedule(userId, sectionId, { force: true });
  return res.ok
    ? { ok: true, notice: `${res.enrollment.section.code_string} added to your plan.` }
    : { ok: false, error: res.error };
}

/** Append the pending-add result to the post-auth destination as ?ok=/?err=. */
function withNotice(path: string, state: ActionState): string {
  if (state === null) return path;
  const url = new URL(path, "http://internal");
  if (state.ok) url.searchParams.set("ok", state.notice ?? "");
  else url.searchParams.set("err", state.error ?? "");
  return url.pathname + url.search;
}

export async function logoutAction(): Promise<void> {
  assertActionsEnabled();
  await endSession();
  revalidateAll();
  redirect("/");
}

/* ------------------------------- profile ------------------------------- */

export async function updateProfileAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();

  const school = formStr(fd, "school").toUpperCase();
  if (!SCHOOL_BY_CODE[school]) return { ok: false, error: "Unknown campus." };

  const majorId = formStr(fd, "majorId") || null;
  const major2Id = formStr(fd, "major2Id") || null;
  const minorId = formStr(fd, "minorId") || null;
  const allSets = (await listSets()).map((s) => s.id);
  if (majorId && !allSets.includes(majorId))
    return { ok: false, error: "Unknown major." };
  if (major2Id && !allSets.includes(major2Id))
    return { ok: false, error: "Unknown second major." };
  if (major2Id && major2Id === majorId)
    return { ok: false, error: "The second major must be a different program." };
  if (minorId && !allSets.includes(minorId))
    return { ok: false, error: "Unknown minor." };

  await updateUserProfile(user.id, {
    name: formStr(fd, "name") || user.name,
    school: school as SchoolCode,
    grad_year: formNum(fd, "gradYear"),
    major_id: majorId,
    major2_id: major2Id,
    minor_id: minorId,
    track_id: trackIdFrom(fd),
    advisor: formStr(fd, "advisor") || null,
  });

  // Manual assignments pointing at sets the profile no longer tracks are stale.
  await pruneAssignments(
    user.id,
    [`ge-${school}`, majorId, major2Id, minorId, trackIdFrom(fd)].filter(Boolean) as string[],
  );

  revalidateAll();
  return {
    ok: true,
    notice: major2Id
      ? "Profile saved. Your checklist now tracks both majors, the minor and your GE."
      : "Profile saved. Your checklist now tracks that program.",
  };
}

export async function changePasswordAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const current = formStr(fd, "current");
  const next = formStr(fd, "next");
  if (next.length < 8) return { ok: false, error: "New password must be 8+ characters." };

  const row = await get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    [user.id],
  );
  if (!row) return { ok: false, error: "Account not found." };
  if (!verifyPassword(current, row.password_hash))
    return { ok: false, error: "Current password is wrong." };

  await run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(next), user.id]);
  return { ok: true, notice: "Password changed." };
}

/* ----------------------------- sample plan ----------------------------- */

/**
 * Fill the current term with real, open, non-conflicting courses chosen by the
 * requirement engine, so the checklist visibly moves. Idempotent-ish: courses
 * already planned are skipped.
 */
export async function seedSamplePlanAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const term = formStr(fd, "term") || (await currentTermId());
  const max = Math.min(Math.max(formNum(fd, "courses") ?? 5, 1), 8);

  const choices = await buildSamplePlan(user, term, max);
  if (!choices.length)
    return {
      ok: false,
      error: `No open sections in ${term} matched your requirements yet. Sync the catalog first.`,
    };

  const added = await applySamplePlan(user.id, choices);
  revalidateAll();
  return {
    ok: true,
    notice: added
      ? `Added ${added} suggested ${term} course${added === 1 ? "" : "s"} to your plan.`
      : "Your plan already includes everything we would suggest.",
  };
}

export async function clearSamplePlanAction(): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const res = await run("DELETE FROM enrollments WHERE user_id = ? AND note = 'sample'", [user.id]);
  revalidateAll();
  return {
    ok: true,
    notice: `Removed ${res.changes} sample course${res.changes === 1 ? "" : "s"}.`,
  };
}

/* ---------------------------- danger zone ------------------------------ */

export async function wipeAccountAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  if (formStr(fd, "confirm").toUpperCase() !== "DELETE")
    return { ok: false, error: "Type DELETE to confirm." };

  await tx(async () => {
    await run("DELETE FROM enrollments WHERE user_id = ?", [user.id]);
    await run("DELETE FROM reviews WHERE user_id = ?", [user.id]);
    await run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
    await run("DELETE FROM users WHERE id = ?", [user.id]);
  });
  await endSession();
  revalidateAll();
  redirect("/");
}

/* --------------------------- change email (verified) --------------------------- */

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const hashCode = (code: string) => crypto.createHash("sha256").update(code).digest("hex");


/** Email a fresh 6-digit code to `email` for this user and remember its hash. */
async function issueEmailCode(userId: string, email: string): Promise<{ ok: boolean; error?: string }> {
  if (!mailConfigured())
    return { ok: false, error: "Email sending isn't set up on this site yet, so a code can't be sent." };
  const prev = await get<{ created_at: string }>("SELECT created_at FROM email_changes WHERE user_id = ?", [userId]);
  if (prev && Date.now() - Date.parse(prev.created_at) < RESEND_WAIT_MS)
    return { ok: false, error: "A code was just sent. Wait a minute before asking for another." };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const sent = await sendEmail(
    email,
    "Your 5Cycle verification code",
    `Your 5Cycle verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for this, ignore this message.`,
  );
  if (!sent) return { ok: false, error: "Couldn't send the email. Check the address and try again." };
  await run(
    `INSERT INTO email_changes(user_id, new_email, code_hash, attempts, expires_at, created_at)
     VALUES(?,?,?,0,?,?)
     ON CONFLICT(user_id) DO UPDATE SET new_email=excluded.new_email, code_hash=excluded.code_hash,
       attempts=0, expires_at=excluded.expires_at, created_at=excluded.created_at`,
    [userId, email, hashCode(code), new Date(Date.now() + CODE_TTL_MS).toISOString(), nowIso()],
  );
  return { ok: true };
}

/** After an account exists: send the verification code and go to the code page. */
async function verifyThenGo(userId: string, email: string, dest: string): Promise<never> {
  const r = await issueEmailCode(userId, email);
  if (r.ok) redirect(`/verify-email?next=${encodeURIComponent(dest)}`);
  redirect(dest);
}

/** Step 1: check the password, then email a 6-digit code to the NEW address. */
export async function requestEmailChangeAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  if (isGuestUser(user)) return { ok: false, error: "Create an account first." };
  const email = formStr(fd, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  const verified = await get<{ v: string | null }>("SELECT email_verified_at v FROM users WHERE id = ?", [user.id]);
  if (email === user.email.toLowerCase() && verified?.v) return { ok: false, error: "That is already your verified email." };
  const row = await get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [user.id]);
  if (!row || !verifyPassword(formStr(fd, "password"), row.password_hash))
    return { ok: false, error: "Password is wrong." };
  if (await get("SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?", [email, user.id]))
    return { ok: false, error: "That email is already used by another account." };
  const issued = await issueEmailCode(user.id, email);
  if (!issued.ok) return issued;
  return { ok: true, notice: `We sent a 6-digit code to ${email}.` };
}

/** Step 2: the student types the code; only then does the email change. */
export async function verifyEmailChangeAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const code = formStr(fd, "code").replace(/\D/g, "");
  const pend = await get<{ new_email: string; code_hash: string; attempts: number; expires_at: string }>(
    "SELECT new_email, code_hash, attempts, expires_at FROM email_changes WHERE user_id = ?",
    [user.id],
  );
  if (!pend) return { ok: false, error: "No email change is pending." };
  if (Date.parse(pend.expires_at) < Date.now()) {
    await run("DELETE FROM email_changes WHERE user_id = ?", [user.id]);
    return { ok: false, error: "That code expired. Request a new one." };
  }
  if (pend.attempts >= MAX_ATTEMPTS) {
    await run("DELETE FROM email_changes WHERE user_id = ?", [user.id]);
    return { ok: false, error: "Too many wrong tries. Request a new code." };
  }
  if (hashCode(code) !== pend.code_hash) {
    await run("UPDATE email_changes SET attempts = attempts + 1 WHERE user_id = ?", [user.id]);
    return { ok: false, error: "That code isn't right." };
  }
  if (await get("SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?", [pend.new_email, user.id])) {
    await run("DELETE FROM email_changes WHERE user_id = ?", [user.id]);
    return { ok: false, error: "That email is already used by another account." };
  }
  await tx(async () => {
    await run("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?", [pend.new_email, nowIso(), user.id]);
    await run("DELETE FROM email_changes WHERE user_id = ?", [user.id]);
  });
  revalidateAll();
  return { ok: true, notice: pend.new_email === user.email.toLowerCase() ? "Email verified." : `Email changed to ${pend.new_email}.` };
}

export async function cancelEmailChangeAction(): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  await run("DELETE FROM email_changes WHERE user_id = ?", [user.id]);
}

/** Resend the code for the signup verification page (to the account's own email). */
export async function resendVerificationAction(): Promise<{ ok: boolean; error?: string }> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  return issueEmailCode(user.id, user.email.toLowerCase());
}

/** Profile: turn "email me when a seat opens" on or off. */
export async function setNotifyEmailAction(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  await run("UPDATE users SET notify_email = ? WHERE id = ?", [fd.get("notifyEmail") ? 1 : 0, user.id]);
  revalidatePath("/profile");
}
