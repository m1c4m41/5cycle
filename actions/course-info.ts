"use server";
/** Course lookup for the prerequisite pop-out: title + description by course code. */
import { get } from "@/lib/db";

export type CourseInfo =
  | { found: true; code: string; title: string; description: string }
  | { found: false; code: string };

type Row = { code_string: string; title: string; description: string };

export async function lookupCourse(dept: string, number: number, suffix: string, affiliation: string): Promise<CourseInfo> {
  const d = String(dept).toUpperCase().slice(0, 8);
  const n = Math.floor(Number(number));
  const sfx = String(suffix || "").toUpperCase().slice(0, 4);
  const aff = String(affiliation || "").toUpperCase().slice(0, 3);
  const label = `${d} ${String(n).padStart(3, "0")}${sfx}${aff ? ` ${aff}` : ""}`;
  if (!d || !Number.isFinite(n)) return { found: false, code: label };

  // Newest term first; prefer the exact suffix/affiliation, then relax.
  const attempts: [string, (string | number)[]][] = [];
  if (aff) attempts.push(["department = ? AND course_number = ? AND suffix = ? AND affiliation = ?", [d, n, sfx, aff]]);
  attempts.push(["department = ? AND course_number = ? AND suffix = ?", [d, n, sfx]]);
  if (!sfx) attempts.push(["department = ? AND course_number = ?", [d, n]]);
  for (const [where, params] of attempts) {
    const r = await get<Row>(
      `SELECT code_string, title, description FROM sections WHERE ${where} ORDER BY term_id DESC LIMIT 1`,
      params,
    );
    if (r) {
      return {
        found: true,
        code: label,
        title: r.title,
        description: (r.description ?? "").replace(/\s+/g, " ").trim().slice(0, 700),
      };
    }
  }
  return { found: false, code: label };
}
