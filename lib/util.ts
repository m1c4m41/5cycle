import { SCHOOL_BY_CODE, WEEKDAY_ORDER, type SchoolCode } from "./constants";

/**
 * School-email domains → home campus. HyperSchedule sign-in is by school email,
 * so a student's address already tells us their campus; signup uses this to
 * pre-select (and the server uses it as a fallback when the campus field is
 * left blank).
 */
const EMAIL_DOMAIN_SCHOOLS: Array<[string, SchoolCode]> = [
  ["pomona.edu", "PO"],
  ["scrippscollege.edu", "SC"],
  ["cmc.edu", "CM"],
  ["pitzer.edu", "PZ"],
  ["harvey-mudd.edu", "HM"],
  ["cgu.edu", "CG"],
];

export function inferSchoolFromEmail(email: string): SchoolCode | null {
  const at = email.toLowerCase().lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim();
  for (const [d, code] of EMAIL_DOMAIN_SCHOOLS) {
    if (domain === d || domain.endsWith("." + d)) return code;
  }
  return null;
}

/** join truthy class names */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** 53100 -> '14:45' */
export function secondsToHHMM(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 53100 -> '2:45 pm' */
export function secondsTo12h(secs: number): string {
  const h24 = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const ampm = h24 >= 12 ? "pm" : "am";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

export function formatMeeting(m: {
  days: string;
  start_time: number;
  end_time: number;
  locations: string;
}): string {
  const days = sortDays(m.days);
  const time = `${secondsTo12h(m.start_time)}–${secondsTo12h(m.end_time)}`;
  const loc = m.locations ? ` · ${m.locations}` : "";
  return `${days} ${time}${loc}`;
}

export function sortDays(days: string): string {
  return days
    .split("")
    .filter((d) => WEEKDAY_ORDER.includes(d as (typeof WEEKDAY_ORDER)[number]))
    .sort((a, b) => WEEKDAY_ORDER.indexOf(a as never) - WEEKDAY_ORDER.indexOf(b as never))
    .join("");
}

/** 'CSCI' + 5 -> 'CSCI 005' */
export function formatCourseNumber(n: number): string {
  return String(n).padStart(3, "0");
}

export function buildCourseCode(p: {
  department: string;
  courseNumber: number;
  suffix: string;
  affiliation: string;
}): string {
  return `${p.department} ${formatCourseNumber(p.courseNumber)}${p.suffix} ${p.affiliation}`;
}

export function buildCodeString(p: {
  department: string;
  courseNumber: number;
  suffix: string;
  affiliation: string;
  sectionNumber: number;
  term: string;
}): string {
  return `${buildCourseCode(p)}-${String(p.sectionNumber).padStart(2, "0")} · ${p.term}`;
}

export function buildSectionId(p: {
  department: string;
  courseNumber: number;
  suffix: string;
  affiliation: string;
  sectionNumber: number;
  term: string;
}): string {
  return [
    p.department,
    formatCourseNumber(p.courseNumber) + p.suffix,
    p.affiliation,
    String(p.sectionNumber).padStart(2, "0"),
    p.term,
  ].join("-");
}

export function schoolShort(code: string): string {
  return SCHOOL_BY_CODE[code]?.short ?? code;
}

export function schoolName(code: string): string {
  return SCHOOL_BY_CODE[code]?.name ?? code;
}

/** Credit scales differ: HMC is on a 3-credit course scale, the rest on 1.0. */
export function formatCredits(credits: number, school?: string): string {
  const base = Number.isInteger(credits) ? String(credits) : credits.toFixed(2).replace(/0$/, "");
  return `${base} ${credits === 1 ? "cred" : "creds"}${school === "HM" ? " (HMC scale)" : ""}`;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(prof|professor|dr|mr|mrs|ms|mrsw)\b\.?/g, "")
    .replace(/[.,']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(input: string): string {
  return normalizeName(input).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Do two [start,end) second-ranges overlap? */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/** 'FA2026' -> 'Fall 2026' */
export function termLabel(id: string): string {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(id);
  if (!m) return id;
  const word = m[1] === "FA" ? "Fall" : m[1] === "SP" ? "Spring" : "Summer";
  return `${word} ${m[2]}`;
}

export function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
  });
}
