"use server";
/**
 * Server Actions — manual counting (multi-box) + manual courses + abroad flag.
 *
 * A course can be checked off against several requirement boxes at once:
 * across sets (GE + major + minor may all take the same class) and, inside a
 * set, Educational-Objective / Breadth boxes may take a course more than
 * once. Manual courses (study abroad, transfer credit, create-your-own) get
 * the same treatment. 0.5-credit courses can't tick GE or Breadth boxes — the
 * engine enforces that; their credits still count toward the total.
 */
import { redirect } from "next/navigation";
import { getSection } from "@/lib/catalog";
import {
  addManualCourse,
  groupLabel,
  getManualCourse,
  removeManualCourse,
  setAbroadFlag,
  setCourseAssignments,
} from "@/lib/requirements";
import type { ManualCourseKind } from "@/lib/types";
import { termLabel } from "@/lib/util";
import {
  assertActionsEnabled,
  formNum,
  formStr,
  revalidateSchedule,
  userOrRedirect,
} from "@/lib/server";

/** Append ?ok= / ?err= to `next`, keeping any existing query intact. */
function withNotice(next: string, key: "ok" | "err", value: string): string {
  const url = new URL(next, "http://internal");
  url.searchParams.set(key, value);
  return url.pathname + url.search;
}

const cr = (n: number) => String(Number(n.toFixed(2)));

const KIND_LABEL: Record<ManualCourseKind, string> = {
  abroad: "study abroad",
  transfer: "transfer credit",
  custom: "create-your-own",
};

/**
 * Replace the checked boxes for one course.
 * Form fields: courseId, courseKind ('section'|'manual'), groupId[] (the
 * checked boxes), note (optional), next. The "Release all" button submits
 * name="release" value="1" and clears everything back to automatic.
 */
export async function saveCourseCounting(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const next = formStr(fd, "next") || "/requirements";
  const courseId = formStr(fd, "courseId");
  const courseKind = formStr(fd, "courseKind") === "manual" ? "manual" : "section";
  const note = formStr(fd, "note");
  let groupIds = fd
    .getAll("groupId")
    .map((v) => v.toString().trim())
    .filter(Boolean);

  const label =
    courseKind === "manual"
      ? (await getManualCourse(courseId, user.id))?.title ?? "That course"
      : (await getSection(courseId))?.code_string ?? "That course";

  if (!courseId) redirect(withNotice(next, "err", "Pick the course to count first."));
  if (fd.has("release")) groupIds = [];

  const res = await setCourseAssignments(user.id, courseId, courseKind, groupIds, note || null);
  if (!res.ok) redirect(withNotice(next, "err", res.error));
  revalidateSchedule();

  if (groupIds.length === 0) {
    redirect(
      withNotice(next, "ok", `${label} is back on automatic — the engine decides where it counts.`),
    );
  }
  const labels = (
    await Promise.all(groupIds.map(async (g) => (await groupLabel(g)) ?? g))
  ).join("; ");
  redirect(
    withNotice(
      next,
      "ok",
      `${label} now counts toward ${labels}${note ? ` (note: ${note})` : ""}. A course may tick several boxes — and Educational-Objective / Breadth boxes may take it more than once inside a set.`,
    ),
  );
}

/**
 * Add a manually-entered course (study abroad / transfer / create-your-own).
 * Form fields: title, credits, kind (abroad|transfer|custom), termId (a real
 * synced term — both the planner and checklist forms always send one),
 * groupId[] (boxes it already counts toward), note, next.
 */
export async function addManualCourseAction(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const next = formStr(fd, "next") || "/requirements";

  const title = formStr(fd, "title");
  const credits = formNum(fd, "credits");
  const kindRaw = formStr(fd, "kind");
  const kind: ManualCourseKind =
    kindRaw === "abroad" || kindRaw === "transfer" ? kindRaw : "custom";
  const termId = formStr(fd, "termId");
  const termLabelRaw = formStr(fd, "termLabel");
  const note = formStr(fd, "note");
  const groupIds = fd
    .getAll("groupId")
    .map((v) => v.toString().trim())
    .filter(Boolean);

  const res = await addManualCourse(user.id, {
    term_id: termId || null,
    term_label: termLabelRaw,
    title,
    credits: credits ?? NaN,
    kind,
    note: note || null,
  });
  if (!res.ok) redirect(withNotice(next, "err", res.error));

  if (groupIds.length > 0) {
    const assign = await setCourseAssignments(user.id, res.id, "manual", groupIds, note || null);
    if (!assign.ok) redirect(withNotice(next, "err", assign.error));
  }
  revalidateSchedule();

  const when = termId ? termLabel(termId) : termLabelRaw.trim() || "a later term";
  const boxes = groupIds.length
    ? ` It counts toward ${(
        await Promise.all(groupIds.map(async (g) => (await groupLabel(g)) ?? g))
      ).join("; ")}.`
    : " The engine will find boxes for it automatically.";
  redirect(
    withNotice(
      next,
      "ok",
      `Added “${title.trim()}” (${cr(credits ?? 0)} cr, ${KIND_LABEL[kind]}, ${when}) to your plan.${boxes}`,
    ),
  );
}

/** Form fields: id (manual course), next. */
export async function removeManualCourseAction(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const next = formStr(fd, "next") || "/requirements";
  const id = formStr(fd, "id");
  const m = id ? await getManualCourse(id, user.id) : undefined;
  if (!m) redirect(withNotice(next, "err", "That manual course is not yours."));
  await removeManualCourse(user.id, id);
  revalidateSchedule();
  redirect(
    withNotice(next, "ok", `Removed “${m.title}” from your plan — its counting boxes came with it.`),
  );
}

/**
 * Toggle the "studying abroad this term" flag on the planner.
 * Form fields: termId, abroad (checkbox — present only when checked), next.
 */
export async function setAbroadAction(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const next = formStr(fd, "next") || "/planner";
  const termId = formStr(fd, "termId");
  if (!termId) redirect(withNotice(next, "err", "Pick a term first."));
  const abroad = fd.has("abroad");
  await setAbroadFlag(user.id, termId, abroad);
  revalidateSchedule();
  redirect(
    withNotice(
      next,
      "ok",
      abroad
        ? `${termLabel(termId)} is marked as a study-abroad term — add the courses manually (they won't be in the catalog).`
        : `${termLabel(termId)} is no longer marked as study abroad.`,
    ),
  );
}
