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
  createUser,
  endSession,
  hashPassword,
  startSession,
  updateUserProfile,
  verifyPassword,
} from "@/lib/session";
import { get, run, tx } from "@/lib/db";
import { listSets, pruneAssignments } from "@/lib/requirements";
import { inferSchoolFromEmail } from "@/lib/util";
import { applySamplePlan, buildSamplePlan } from "@/lib/sample";
import { addToSchedule } from "@/lib/schedule";
import { currentTermId } from "@/lib/ingest";
import { SCHOOL_BY_CODE, type SchoolCode } from "@/lib/constants";
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

  const res = await createUser({
    name: formStr(fd, "name"),
    email: formStr(fd, "email"),
    password: formStr(fd, "password"),
    school,
    gradYear: formNum(fd, "gradYear"),
    majorId: formStr(fd, "majorId") || null,
    major2Id: formStr(fd, "major2Id") || null,
    minorId: formStr(fd, "minorId") || null,
  });
  if (!res.ok) return { ok: false, error: res.error };

  await startSession(res.id);
  const pending = await applyPendingAdd(res.id, fd);
  revalidateAll();
  const url = new URL(safeNext(formStr(fd, "next"), "/planner"), "http://internal");
  url.searchParams.set("welcome", "1");
  if (pending !== null) {
    if (pending.ok) url.searchParams.set("ok", pending.notice ?? "");
    else url.searchParams.set("err", pending.error ?? "");
  }
  redirect(url.pathname + url.search);
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
  const res = await addToSchedule(userId, sectionId, { force: formStr(fd, "force") === "1" });
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
    advisor: formStr(fd, "advisor") || null,
  });

  // Manual assignments pointing at sets the profile no longer tracks are stale.
  await pruneAssignments(
    user.id,
    [`ge-${school}`, majorId, major2Id, minorId].filter(Boolean) as string[],
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
