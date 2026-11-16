"use client";
/**
 * Add / remove a section from the student's plan.
 *
 * Conflicts are a *soft* block: the first submit fails with the conflict detail
 * and the component then offers an explicit "add anyway" that re-submits with
 * force=1. Students plan double-majors with weird overlaps; we warn, we don't
 * forbid.
 */
import { useActionState } from "react";
import Link from "next/link";
import { addToPlanAction, removeFromPlanAction } from "@/actions/planner";
import type { ActionState } from "@/lib/server";

export function EnrollButton({
  sectionId,
  inPlan,
  label = "Add to plan",
  next = "/planner",
}: {
  sectionId: string;
  inPlan: boolean;
  label?: string;
  /** Page to return to after sign-in; a guest's add bounces to /login with it. */
  next?: string;
}) {
  const [addState, addAction, pending] = useActionState<ActionState, FormData>(
    addToPlanAction,
    null,
  );
  const [removeState, removeAction, removing] = useActionState<ActionState, FormData>(
    removeFromPlanAction,
    null,
  );

  const state = addState ?? removeState;
  const conflict = !addState?.ok && (addState?.error ?? "").includes("conflict");

  return (
    <div className="flex flex-wrap items-center gap-2">
      {inPlan ? (
        <form action={removeAction}>
          <input type="hidden" name="sectionId" value={sectionId} />
          <button type="submit" className="btn-secondary" disabled={removing}>
            {removing ? "Removing…" : "In your plan ✓ (remove)"}
          </button>
        </form>
      ) : (
        <form action={addAction}>
          <input type="hidden" name="sectionId" value={sectionId} />
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="btn-primary" disabled={pending}>
            {pending ? "Adding…" : label}
          </button>
        </form>
      )}

      {conflict && (
        <form action={addAction}>
          <input type="hidden" name="sectionId" value={sectionId} />
          <input type="hidden" name="force" value="1" />
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="btn border border-amber-400 bg-amber-50 text-amber-800">
            Overlap: add anyway
          </button>
        </form>
      )}

      {state?.error && !conflict && (
        <span className="text-xs font-medium text-red-700">{state.error}</span>
      )}
      {state?.notice && (
        <span className="text-xs font-medium text-emerald-700">{state.notice}</span>
      )}
      {conflict && <span className="text-xs text-amber-800">{addState?.error}</span>}
      {inPlan && (
        <Link href="/planner" className="text-xs text-ink-500 underline-offset-2 hover:underline">
          view planner
        </Link>
      )}
    </div>
  );
}
