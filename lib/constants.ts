/** Static reference data for the Claremont Colleges consortium. */

export type SchoolCode = "CM" | "HM" | "PZ" | "PO" | "SC" | "CG" | "UN";

export type School = {
  code: SchoolCode;
  slug: string;
  name: string;
  short: string;
  /** UI accent only — not an official brand color. */
  accent: string;
  registrarUrl: string;
  /** Prefix used in HyperSchedule course-area GE codes (1=POM, 2=SCR, 3=CMC, 4=HM, 5=PZ). */
  gePrefix: string;
};

export const SCHOOLS: School[] = [
  {
    code: "CM",
    slug: "cmc",
    name: "Claremont McKenna College",
    short: "CMC",
    accent: "var(--color-cmc)",
    registrarUrl: "https://portal.claremontmckenna.edu/",
    gePrefix: "3",
  },
  {
    code: "HM",
    slug: "hmc",
    name: "Harvey Mudd College",
    short: "HMC",
    accent: "var(--color-hmc)",
    registrarUrl: "https://portal.hmc.edu/ics/",
    gePrefix: "4",
  },
  {
    code: "PZ",
    slug: "pitzer",
    name: "Pitzer College",
    short: "Pitzer",
    accent: "var(--color-ptz)",
    registrarUrl: "https://mycampus2.pitzer.edu/ICS/",
    gePrefix: "5",
  },
  {
    code: "PO",
    slug: "pomona",
    name: "Pomona College",
    short: "Pomona",
    accent: "var(--color-pom)",
    registrarUrl: "https://my.pomona.edu/",
    gePrefix: "1",
  },
  {
    code: "SC",
    slug: "scripps",
    name: "Scripps College",
    short: "Scripps",
    accent: "var(--color-scr)",
    registrarUrl:
      "https://mycampus.scrippscollege.edu/ICS/Portal_Homepage.jnz?portlet=Course_Search&screen=Advanced+Course+Search&screenType=next",
    gePrefix: "2",
  },
  {
    code: "CG",
    slug: "cgu",
    name: "Claremont Graduate University",
    short: "CGU",
    accent: "var(--color-cgu)",
    registrarUrl: "https://www.cgu.edu/academics/registrar/",
    gePrefix: "0",
  },
];

export const SCHOOL_BY_CODE: Record<string, School> = Object.fromEntries(
  SCHOOLS.map((s) => [s.code, s]),
);

/** Consortium / cross-listing affiliation codes seen in HyperSchedule data. */
export const AFFILIATION_LABELS: Record<string, string> = {
  CM: "Claremont McKenna",
  HM: "Harvey Mudd",
  PZ: "Pitzer",
  PO: "Pomona",
  SC: "Scripps",
  CG: "Claremont Graduate",
  KS: "Keck Science",
  JP: "Joint Program",
  AF: "Africana Studies",
  AA: "Asian American Studies",
  CH: "Chicano-Latinx Studies",
  JM: "Interdisciplinary",
  AS: "Associated",
  UN: "Unknown",
};

export const WEEKDAY_ORDER = ["M", "T", "W", "R", "F", "S", "U"] as const;

export const WEEKDAY_LABELS: Record<string, string> = {
  M: "Mon",
  T: "Tue",
  W: "Wed",
  R: "Thu",
  F: "Fri",
  S: "Sat",
  U: "Sun",
};

/**
 * Full-screen grid rows for the weekly timetable. 08:00 → 22:00.
 */
export const TIMETABLE_START = 8 * 3600;
export const TIMETABLE_END = 22 * 3600;

export const STATUS_LABELS: Record<string, string> = {
  O: "Open",
  C: "Closed",
  R: "Reopened",
  U: "Unknown",
};
