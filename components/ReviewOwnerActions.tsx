"use client";
/** Edit / delete controls shown on a student's own review, wherever it is listed. */
import { useActionState } from "react";
import Link from "next/link";
import { deleteReviewAction } from "@/actions/reviews";
import type { ActionState } from "@/lib/server";

export function ReviewOwnerActions({
  reviewId,
  professorId,
}: {
  reviewId: string;
  professorId: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(deleteReviewAction, null);
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      <Link
        href={`/professors/${encodeURIComponent(professorId)}#edit-review`}
        className="btn-ghost px-2 py-0.5 text-xs"
      >
        Edit
      </Link>
      <form
        action={action}
        onSubmit={(e) => {
          if (!window.confirm("Delete this review? This can't be undone.")) e.preventDefault();
        }}
      >
        <input type="hidden" name="reviewId" value={reviewId} />
        <button
          type="submit"
          className="btn-ghost px-2 py-0.5 text-xs text-red-600"
          disabled={pending}
        >
          {pending ? "Deleting…" : "Delete"}
        </button>
      </form>
      {state?.error && <span className="text-xs text-red-700">{state.error}</span>}
    </div>
  );
}
