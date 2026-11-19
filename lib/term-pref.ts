/**
 * The term a student last picked, remembered in a cookie so it survives
 * refreshes, closing the tab and navigating between pages. An explicit ?term=
 * in the URL always wins; this only fills in when there isn't one.
 */
import { cookies } from "next/headers";
import { get } from "./db";

export const TERM_COOKIE = "term";

/** The remembered term, or "" when none is set or it is no longer a real term. */
export async function preferredTerm(): Promise<string> {
  try {
    const v = (await cookies()).get(TERM_COOKIE)?.value ?? "";
    if (!/^(FA|SP|SU)\d{4}$/.test(v)) return "";
    return (await get<{ id: string }>("SELECT id FROM terms WHERE id = ?", [v]))?.id ?? "";
  } catch {
    return "";
  }
}
