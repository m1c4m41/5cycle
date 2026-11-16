"use server";
/**
 * Server Actions — the planner: add / remove / force-add and status changes.
 * Only async exports live in this file (Next.js constraint for "use server").
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addToSchedule,
  removeFromSchedule,
  setEnrollmentStatus,
} from "@/lib/schedule";
import { getSection } from "@/lib/catalog";
import { run } from "@/lib/db";
import {
  assertActionsEnabled,
  formStr,
  revalidateSchedule,
  safeNext,
  userOrRedirect,
  type ActionState,
} from "@/lib/server";
import { currentUser } from "@/lib/session";

export async function addToPlanAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const sectionId = formStr(fd, "sectionId");
  if (!sectionId) return { ok: false, error: "Missing course." };

  const force = formStr(fd, "force") === "1";

  const user = await currentUser();
  if (!user) {
    // Guest: carry the pending add across to sign-in so login/signup can
    // complete it once the account exists.
    const q = new URLSearchParams();
    q.set("next", safeNext(formStr(fd, "next"), "/planner"));
    q.set("add", sectionId);
    if (force) q.set("force", "1");
    redirect(`/login?${q.toString()}`);
  }

  const res = addToSchedule(user.id, sectionId, { force });
  if (!res.ok) {
    const detail = (res.conflicts ?? [])
      .map((c) => `${c.a.code_string} ↔ ${c.b.code_string}`)
      .join("; ");
    return {
      ok: false,
      error: detail ? `${res.error} (${detail})` : res.error,
    };
  }

  revalidateSchedule();
  revalidatePath("/catalog");
  return {
    ok: true,
    notice: res.warning
      ? `${res.enrollment.section.code_string} — ${res.warning}`
      : `${res.enrollment.section.code_string} added to ${res.enrollment.section.term_id}.` +
        (res.conflicts.length
          ? ` Heads up: ${res.conflicts.length} time conflict(s) you overrode.`
          : ""),
  };
}

export async function removeFromPlanAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const sectionId = formStr(fd, "sectionId");
  const section = getSection(sectionId);
  const removed = removeFromSchedule(user.id, sectionId);
  revalidateSchedule();
  revalidatePath("/catalog");
  return removed
    ? { ok: true, notice: `${section?.code_string ?? "Course"} removed from your plan.` }
    : { ok: false, error: "That course wasn't in your plan." };
}

const STATUSES = new Set(["planned", "waitlist", "perm_requested", "registered"]);

export async function setStatusAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const sectionId = formStr(fd, "sectionId");
  const status = formStr(fd, "status");
  if (!STATUSES.has(status)) return { ok: false, error: "Unknown status." };
  if (!getSection(sectionId)) return { ok: false, error: "Unknown section." };

  setEnrollmentStatus(user.id, sectionId, status);
  revalidateSchedule();
  return { ok: true, notice: `Marked as ${status.replace("_", " ")}.` };
}

export async function clearTermAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const term = formStr(fd, "term");
  if (!term) return { ok: false, error: "Missing term." };
  const res = run("DELETE FROM enrollments WHERE user_id = ? AND term_id = ?", [
    user.id,
    term,
  ]);
  revalidateSchedule();
  return { ok: true, notice: `Cleared ${res.changes} course(s) from ${term}.` };
}
