"use client";
/**
 * Native review form — the only piece of the professor pages that runs in the
 * browser. All writes go through the server actions in actions/reviews.ts
 * (nothing here fetches /api/*), and one student can only have one review per
 * professor: when `existing` is passed we render it prefilled as an edit form
 * and expose delete there, so the server page never needs a FormData-only
 * action wrapper.
 */
import { useActionState, useState } from "react";
import { deleteReviewAction, submitReviewAction } from "@/actions/reviews";
import type { ActionState } from "@/lib/server";
import type { ReviewRow } from "@/lib/types";

const WORKLOADS = ["Manageable", "Moderate", "Heavy"] as const;
const GRADES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"] as const;

export type ReviewFormProps = {
  instructorId: string;
  instructorName: string;
  /** Signed-in user id — only used to namespace control ids on this page. */
  userId?: string;
  /** The viewer's existing review, if any. Prefills the form for editing. */
  existing?: ReviewRow | null;
  /** Optional: scope the review to one section offering. */
  sectionId?: string;
};

export function ReviewForm({
  instructorId,
  instructorName,
  userId,
  existing = null,
  sectionId,
}: ReviewFormProps) {
  const uid = userId ?? "anon";
  const editing = Boolean(existing);

  const [state, action, pending] = useActionState<ActionState, FormData>(submitReviewAction, null);
  const [delState, delAction, deleting] = useActionState<ActionState, FormData>(
    deleteReviewAction,
    null,
  );

  // Visual star fill only — the radio inputs below remain the form's source of truth.
  const [stars, setStars] = useState<number>(existing?.stars ?? 0);

  return (
    <section
      className="card card-pad"
      id={editing ? `edit-review-${uid}` : `write-review-${uid}`}
      aria-labelledby={`review-form-title-${uid}`}
    >
      <h3 id={`review-form-title-${uid}`} className="text-base font-bold text-ink-900">
        {editing ? "Edit your review" : `Review ${instructorName}`}
      </h3>
      <p className="mt-1 text-xs text-ink-500">
        {editing
          ? "Saving replaces your previous review for this professor."
          : "Ratings here come from 5Cycle students and are separate from any RateMyProfessors score shown above."}
      </p>

      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="instructorId" value={instructorId} />
        {sectionId ? <input type="hidden" name="sectionId" value={sectionId} /> : null}

        {/* ------------------------------ stars ------------------------------ */}
        <fieldset>
          <legend className="label">
            Overall rating <span className="text-red-600">*</span>
          </legend>
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <label
                key={n}
                className="cursor-pointer rounded p-0.5 leading-none"
                title={`${n} star${n === 1 ? "" : "s"}`}
              >
                <input
                  type="radio"
                  name="stars"
                  value={n}
                  checked={stars === n}
                  onChange={() => setStars(n)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className={
                    "text-2xl transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40 " +
                    (n <= stars ? "text-amber-500" : "text-ink-300")
                  }
                >
                  ★
                </span>
                <span className="sr-only">
                  {n} star{n === 1 ? "" : "s"}
                </span>
              </label>
            ))}
            <span className="ml-2 text-xs text-ink-500 tabular-nums">
              {stars ? `${stars}/5` : "pick 1–5"}
            </span>
          </div>
        </fieldset>

        {/* --------------------- difficulty / workload / grade -------------------- */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor={`difficulty-${uid}`}>
              Difficulty (1–5)
            </label>
            <input
              id={`difficulty-${uid}`}
              className="input"
              type="number"
              name="difficulty"
              min={1}
              max={5}
              step={0.5}
              defaultValue={existing?.difficulty ?? undefined}
              placeholder="3"
            />
          </div>

          <div>
            <label className="label" htmlFor={`workload-${uid}`}>
              Workload
            </label>
            <select
              id={`workload-${uid}`}
              className="input"
              name="workload"
              defaultValue={existing?.workload ?? ""}
            >
              <option value="">— optional</option>
              {WORKLOADS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor={`grade-${uid}`}>
              Grade you earned
            </label>
            <select
              id={`grade-${uid}`}
              className="input"
              name="grade"
              defaultValue={existing?.grade ?? ""}
            >
              <option value="">— optional</option>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* --------------------------- take again / tags -------------------------- */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`takeAgain-${uid}`}>
              Would you take them again?
            </label>
            <select
              id={`takeAgain-${uid}`}
              className="input"
              name="takeAgain"
              defaultValue={
                existing?.take_again === null || existing?.take_again === undefined
                  ? ""
                  : existing.take_again
                    ? "yes"
                    : "no"
              }
            >
              <option value="">— optional</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor={`tags-${uid}`}>
              Tags
            </label>
            <input
              id={`tags-${uid}`}
              className="input"
              type="text"
              name="tags"
              maxLength={120}
              defaultValue={existing?.tags ?? ""}
              placeholder="Clear grading, Lots of homework"
            />
            <p className="mt-1 text-[11px] text-ink-400">
              Comma separated — up to 8 short tags.
            </p>
          </div>
        </div>

        {/* ------------------------------- the text ------------------------------- */}
        <div>
          <label className="label" htmlFor={`text-${uid}`}>
            Your review <span className="text-red-600">*</span>
          </label>
          <textarea
            id={`text-${uid}`}
            className="input"
            name="text"
            rows={4}
            required
            minLength={15}
            maxLength={4000}
            defaultValue={existing?.text ?? ""}
            placeholder="What made the class work (or not)? Lectures, assignments, grading, office hours…"
          />
          <p className="mt-1 text-[11px] text-ink-400">min 15 characters — be specific.</p>
        </div>

        {/* ------------------------------- buttons -------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary" disabled={pending}>
            {pending ? "Saving…" : editing ? "Update review" : "Post review"}
          </button>
          <span className="text-[11px] text-ink-400">
            Posted anonymously. It is tied to your account so each student counts once per
            professor, and you can edit or delete your own later. Don&apos;t include anything that
            identifies you or another student.
          </span>
        </div>

        {state?.error && (
          <p className="text-sm font-medium text-red-700" role="alert">
            {state.error}
          </p>
        )}
        {state?.notice && (
          <p className="text-sm font-medium text-emerald-700" role="status">
            {state.notice}
          </p>
        )}
      </form>

      {existing?.id ? (
        <form action={delAction} className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
          <input type="hidden" name="reviewId" value={existing.id} />
          <button type="submit" className="btn-danger" disabled={deleting}>
            {deleting ? "Deleting…" : "Delete my review"}
          </button>
          {delState?.error && (
            <span className="text-xs font-medium text-red-700" role="alert">
              {delState.error}
            </span>
          )}
          {delState?.notice && (
            <span className="text-xs font-medium text-emerald-700" role="status">
              {delState.notice}
            </span>
          )}
        </form>
      ) : null}
    </section>
  );
}
