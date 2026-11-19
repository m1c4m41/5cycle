/** Shared by the catalog page and the "load more" server action. */
import type { CatalogQuery } from "./catalog";

export type SP = Record<string, string | string[] | undefined>;

export function list(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  const raw = Array.isArray(v) ? v : [v];
  return raw
    .flatMap((x) => x.split(","))
    .map((x) => x.trim())
    .filter(Boolean);
}
export function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}
export function num(v: string | string[] | undefined): number | undefined {
  const n = Number(one(v));
  return one(v) !== "" && Number.isFinite(n) ? n : undefined;
}
/** Trim trailing zeros for credit totals, e.g. 12.50 -> "12.5". */
export function cr(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** Rebuild a catalog URL with one key changed — used by sort/pagination links. */
export function hrefFor(sp: SP, overrides: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  const merged: SP = { ...sp, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    // `term` must stay a single value: a duplicated term param (term=A&term=B)
    // used to serialize as "A,B" and silently matched nothing on every
    // generated Next/Previous link.
    const val = k === "term" ? (Array.isArray(v) ? v[0] ?? "" : v) : Array.isArray(v) ? v.join(",") : String(v);
    if (val === "") continue;
    q.set(k, val);
  }
  const s = q.toString();
  return `/catalog${s ? `?${s}` : ""}`;
}


/** The search filters in the URL, as a catalog query (no paging). */
export function queryFromSp(sp: SP, term: string, notAtSchool: string): CatalogQuery {
  return {
    q: one(sp.q) || undefined,
    term,
    schools: list(sp.school),
    departments: list(sp.dept),
    areas: list(sp.area),
    instructor: one(sp.instructor) || undefined,
    minCredits: num(sp.minCredits),
    maxCredits: num(sp.maxCredits),
    openOnly: one(sp.open) === "1",
    permOnly: one(sp.perm) === "1",
    notAtSchool: notAtSchool || undefined,
    sort: (one(sp.sort) || "code") as "code" | "title" | "credits" | "perm",
  };
}
