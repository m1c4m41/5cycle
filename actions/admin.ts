"use server";
/**
 * Server Actions — catalog sync, requirement reloads and RMP import controls.
 *
 * These write to the shared catalog, so they're gated fail-closed: the caller
 * must be signed in AND present the CYCLE_ADMIN_TOKEN (isAdminToken in
 * lib/server.ts). With no token configured, every action here is denied —
 * never open by default.
 */
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { manualSync } from "@/lib/autosync";
import { syncCourseAreas } from "@/lib/ingest";
import { loadRequirementFiles, requirementsLoaded } from "@/lib/requirements";
import { importManualRmp } from "@/lib/rmp";
import {
  assertActionsEnabled,
  formStr,
  isAdminToken,
  type ActionState,
} from "@/lib/server";

const DENIED: ActionState = { ok: false, error: "Admin token required." };

export async function syncCatalogAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  await requireUser();
  if (!isAdminToken(formStr(fd, "token"))) return DENIED;

  const term = formStr(fd, "term");
  // manualSync takes the same lock the background auto-sync uses, so a click
  // here and the timer can never rewrite the catalog at once.
  const res = await manualSync(term || undefined);
  if (res.skipped) return { ok: false, error: res.skipped };
  const reports = res.reports ?? [];
  if (!(await requirementsLoaded())) await loadRequirementFiles();
  revalidatePath("/catalog", "layout");
  revalidatePath("/requirements");
  revalidatePath("/admin");
  return {
    ok: true,
    notice: reports.length
      ? `Synced ${reports.length} term(s)${
          res.current ? `, current = ${res.current}` : ""
        }: ` + reports.map((r) => `${r.term} (${r.sections})`).join(", ")
      : "Sync ran but found no terms — check network access to the course data feed.",
  };
}

export async function syncAreasAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  await requireUser();
  if (!isAdminToken(formStr(fd, "token"))) return DENIED;

  const n = await syncCourseAreas(true);
  revalidatePath("/catalog", "layout");
  return { ok: true, notice: `Refreshed ${n} registrar course-area designations.` };
}

export async function reloadRequirementsAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  await requireUser();
  if (!isAdminToken(formStr(fd, "token"))) return DENIED;

  const res = await loadRequirementFiles();
  revalidatePath("/requirements", "layout");
  revalidatePath("/catalog");
  revalidatePath("/admin");
  return {
    ok: true,
    notice: `Reloaded data/requirements/*.json → ${res.sets} sets, ${res.groups} groups.`,
  };
}

/** Curated JSON import — no network, no ToS exposure. */
export async function importRmpAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  await requireUser();
  if (!isAdminToken(formStr(fd, "token"))) return DENIED;

  const res = await importManualRmp();
  revalidatePath("/professors", "layout");
  revalidatePath("/catalog");
  if (!res.matched && !res.missing.length)
    return { ok: false, error: "No data/rmp-manual.json found — create it first." };
  return {
    ok: true,
    notice:
      `Imported ${res.matched} RateMyProfessors score(s).` +
      (res.missing.length ? ` No professor match for: ${res.missing.join(", ")}.` : ""),
  };
}
