/**
 * Client for the public HyperSchedule v4 API (the 5C course data aggregator).
 *
 * Docs: https://github.com/hyperschedule/hyperschedule/blob/v2/shared/API.md
 * Live: https://banana.hyperschedule.io
 *
 * This is the same upstream source hyperschedule.io itself uses, so our catalog
 * is never a stale copy — we re-ingest on demand.
 */
import fs from "node:fs";
import path from "node:path";
import type { SchoolCode } from "./constants";

const BASE = process.env.HYPERSCHEDULE_API || "https://banana.hyperschedule.io";
// Serverless hosts (Vercel) mount the app read-only; only /tmp is writable.
const CACHE_DIR =
  process.env.CYCLE_CACHE_DIR ||
  (process.env.VERCEL ? "/tmp/5cycle-cache" : path.join(process.cwd(), "data", "cache"));

/* ---------------------------- upstream types ---------------------------- */

export type HS_Term = { term: "FA" | "SP" | "SU"; year: number };
export type HS_Date = { year: number; month: number; day: number };

export type HS_Section = {
  courseAreas: string[];
  credits: number;
  permCount: number;
  seatsTotal: number;
  seatsFilled: number;
  status: "O" | "C" | "R" | "U";
  startDate: HS_Date;
  endDate: HS_Date;
  instructors: { name: string }[];
  course: {
    code: {
      department: string;
      courseNumber: number;
      suffix: string;
      affiliation: string;
    };
    title: string;
    description: string;
    primaryAssociation: SchoolCode;
    potentialError: boolean;
  };
  schedules: {
    startTime: number;
    endTime: number;
    days: string[];
    locations: string[];
  }[];
  potentialError: boolean;
  identifier: {
    department: string;
    courseNumber: number;
    suffix: string;
    affiliation: string;
    sectionNumber: number;
    year: number;
    term: "FA" | "SP" | "SU";
    half: { prefix: string; number: number } | null;
  };
};

export type HS_CourseArea = { area: string; description: string };

/* ------------------------------- plumbing ------------------------------- */

async function fetchJson<T>(
  pathname: string,
  { cacheMs = 10 * 60 * 1000, force = false } = {},
): Promise<T> {
  const cacheKey = pathname.replace(/[^a-z0-9]+/gi, "_");
  const cacheFile = path.join(CACHE_DIR, cacheKey + ".json");

  if (!force && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as T;
    }
  }

  const res = await fetch(BASE + pathname, {
    headers: { accept: "application/json", "user-agent": "5cycle-planner/0.1" },
    cache: "no-store",
  });
  if (!res.ok) {
    // Fall back to a stale cache rather than failing the whole sync.
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as T;
    }
    throw new Error(`HyperSchedule ${pathname} -> HTTP ${res.status}`);
  }

  const text = await res.text();
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, text);
  } catch {
    /* read-only filesystem: the cache is an optimisation, never a requirement */
  }
  return JSON.parse(text) as T;
}

/* -------------------------------- calls --------------------------------- */

export async function getCurrentTerm(force = false): Promise<HS_Term> {
  return fetchJson<HS_Term>("/v4/term/current", { cacheMs: 86400_000, force });
}

export async function getAllTerms(force = false): Promise<HS_Term[]> {
  return fetchJson<HS_Term[]>("/v4/term/all", { cacheMs: 86400_000, force });
}

export async function getCourseAreas(force = false): Promise<HS_CourseArea[]> {
  return fetchJson<HS_CourseArea[]>("/v4/course-areas", {
    cacheMs: 7 * 86400_000,
    force,
  });
}

/** ~2,200 sections / ~2.5MB for one term. */
export async function getSections(
  termId: string,
  force = false,
): Promise<HS_Section[]> {
  const future = /^(FA|SP|SU)(\d{4})$/.test(termId);
  return fetchJson<HS_Section[]>(`/v4/sections/${termId}`, {
    // Past terms are immutable; current/future ones change during registration.
    cacheMs: future ? 5 * 60 * 1000 : 30 * 86400_000,
    force,
  });
}

export async function getOfferingHistory(
  termId: string,
  force = false,
): Promise<{ code: unknown; terms: HS_Term[] }[]> {
  return fetchJson(`/v4/offering-history/${termId}`, {
    cacheMs: 7 * 86400_000,
    force,
  });
}

export const API_BASE = BASE;

export function termIdOf(t: HS_Term): string {
  return `${t.term}${t.year}`;
}

/**
 * Terms a student would plausibly plan: current + the following few.
 * Ordered oldest → newest.
 */
export function planningTerms(all: HS_Term[], current: HS_Term): string[] {
  const key = (t: HS_Term) => t.year * 10 + (t.term === "SP" ? 1 : t.term === "FA" ? 2 : 3);
  const cur = key(current);
  return all
    .map((t) => ({ t, k: key(t) }))
    .filter((x) => x.k >= cur - 4)
    .sort((a, b) => a.k - b.k)
    .map((x) => termIdOf(x.t));
}

/**
 * Calendar order inside an academic cycle: Spring, then Fall, then Summer of
 * the same numbered year. Sorting term ids by this key beats sorting them as
 * strings, which puts every Spring after every Fall.
 */
export function termChronoKey(termId: string): number {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(termId);
  if (!m) return 0;
  const rank = m[1] === "SP" ? 1 : m[1] === "FA" ? 2 : 3;
  return Number(m[2]) * 10 + rank;
}
