"use server";
/** Log of clinical / volunteer / shadowing hours, shown on the checklist. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { newId, nowIso, run } from "@/lib/db";
import { assertActionsEnabled, formNum, formStr, userOrRedirect } from "@/lib/server";

const KINDS = ["volunteer", "shadowing", "paid", "other"];
/** Back to the checklist with the track card open (SetCard opens on its #set-<id> hash). */
const back = (q: string, track = ""): never =>
{
  const ok = /^track-[a-z]+$/.test(track);
  redirect(`/requirements?${q}${ok ? `&open=set-${track}` : ""}#${ok ? `set-${track}` : "hours"}`);
}

export async function addExperienceForm(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const job = formStr(fd, "job").slice(0, 120);
  const location = formStr(fd, "location").slice(0, 120);
  const doctor = formStr(fd, "doctor").slice(0, 120);
  const kind = KINDS.includes(formStr(fd, "kind")) ? formStr(fd, "kind") : "other";
  const hours = formNum(fd, "hours");
  const track = formStr(fd, "track");
  if (!job) back("err=" + encodeURIComponent("Add a job or activity (for example “ER volunteer”)."), track);
  if (hours === null || !(hours > 0) || hours > 10000)
    back("err=" + encodeURIComponent("Enter the number of hours (more than 0)."), track);
  await run(
    "INSERT INTO experience_hours(id, user_id, kind, job, location, doctor, hours, created_at) VALUES(?,?,?,?,?,?,?,?)",
    [newId("exp-"), user.id, kind, job, location || null, doctor || null, Math.round((hours as number) * 100) / 100, nowIso()],
  );
  revalidatePath("/requirements");
  back("ok=" + encodeURIComponent("Hours added."), track);
}

export async function deleteExperienceForm(fd: FormData): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  await run("DELETE FROM experience_hours WHERE id = ? AND user_id = ?", [formStr(fd, "id"), user.id]);
  revalidatePath("/requirements");
  back("ok=" + encodeURIComponent("Entry removed."), formStr(fd, "track"));
}
