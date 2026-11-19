"use server";
/**
 * Server Actions — native professor reviews.
 *
 * Our own star ratings live in SQLite. The RateMyProfessors score is a separate
 * mirrored column (see lib/rmp.ts); this file never writes to it.
 */
import { isGuestUser } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { all, get, newId, nowIso, run, tx } from "@/lib/db";
import { normalizeName } from "@/lib/util";
import {
  assertActionsEnabled,
  formNum,
  formStr,
  userOrRedirect,
  type ActionState,
} from "@/lib/server";

function parseTags(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export async function submitReviewAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  if (isGuestUser(user))
    return { ok: false, error: "Create an account (Account → Save your plan) to post reviews." };

  const instructorId = formStr(fd, "instructorId");
  const stars = formNum(fd, "stars") ?? 0;
  const text = formStr(fd, "text");

  if (!instructorId) return { ok: false, error: "Missing professor." };
  if (stars < 1 || stars > 5) return { ok: false, error: "Pick 1–5 stars." };
  if (text.length < 15)
    return { ok: false, error: "Reviews need at least 15 characters — be specific." };

  const instructor = await get<{ id: string; name: string }>(
    "SELECT id, name FROM instructors WHERE id = ?",
    [instructorId],
  );
  if (!instructor) return { ok: false, error: "Unknown professor." };

  const difficulty = formNum(fd, "difficulty");
  if (difficulty !== null && (difficulty < 1 || difficulty > 5))
    return { ok: false, error: "Difficulty must be between 1 and 5." };

  const sectionId = formStr(fd, "sectionId") || null;
  if (sectionId && !(await get("SELECT id FROM sections WHERE id = ?", [sectionId])))
    return { ok: false, error: "Unknown course." };

  // One review per professor per student: edit rather than stack.
  const existing = await get<{ id: string }>(
    "SELECT id FROM reviews WHERE instructor_id = ? AND user_id = ?",
    [instructorId, user.id],
  );

  await tx(async () => {
    if (existing) {
      await run(
        `UPDATE reviews SET stars=?, difficulty=?, workload=?, grade=?, take_again=?,
           text=?, tags=?, section_id=?, created_at=? WHERE id=?`,
        [
          stars,
          difficulty,
          formStr(fd, "workload") || null,
          formStr(fd, "grade") || null,
          formStr(fd, "takeAgain") === "yes" ? 1 : 0,
          text,
          parseTags(formStr(fd, "tags")).join(","),
          sectionId,
          nowIso(),
          existing.id,
        ],
      );
    } else {
      await run(
        `INSERT INTO reviews(id, user_id, instructor_id, section_id, stars, difficulty,
           workload, grade, take_again, text, tags, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId("rev-"),
          user.id,
          instructorId,
          sectionId,
          stars,
          difficulty,
          formStr(fd, "workload") || null,
          formStr(fd, "grade") || null,
          formStr(fd, "takeAgain") === "yes" ? 1 : 0,
          text,
          parseTags(formStr(fd, "tags")).join(","),
          nowIso(),
        ],
      );
    }
  });

  revalidatePath("/professors", "layout");
  revalidatePath("/reviews");
  revalidatePath("/catalog");
  revalidatePath("/section");
  return {
    ok: true,
    notice: existing
      ? "Review updated — thanks for keeping it current."
      : `Review saved for ${instructor.name}.`,
  };
}

export async function deleteReviewAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  const id = formStr(fd, "reviewId");
  const res = await run("DELETE FROM reviews WHERE id = ? AND user_id = ?", [id, user.id]);
  if (!res.changes) return { ok: false, error: "Review not found (or not yours)." };
  revalidatePath("/professors", "layout");
  revalidatePath("/reviews");
  revalidatePath("/catalog");
  return { ok: true, notice: "Review deleted." };
}


