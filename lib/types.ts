import type { SchoolCode } from "./constants";

/** Raw row from `sections`. */
export type SectionRow = {
  id: string;
  term_id: string;
  department: string;
  course_number: number;
  suffix: string;
  affiliation: string;
  section_number: number;
  half: string | null;
  code_string: string;
  course_code: string;
  title: string;
  description: string;
  school: SchoolCode;
  credits: number;
  perm_count: number;
  seats_total: number;
  seats_filled: number;
  status: string;
  start_date: string | null;
  end_date: string | null;
  potential_error: number;
};

export type Meeting = {
  days: string;
  start_time: number;
  end_time: number;
  locations: string;
};

export type InstructorRef = {
  id: string;
  name: string;
  avg_stars: number | null;
  review_count: number;
  rmp_quality: number | null;
  rmp_num_ratings: number | null;
  rmp_url: string | null;
};

export type AreaRef = {
  code: string;
  description: string;
  kind: string;
  school: string | null;
};

/** A section joined with its meetings, instructors and course areas. */
export type Section = SectionRow & {
  school_short: string;
  /**
   * Campus-normalized credits. HMC runs a 3-credit course scale where one
   * course = 1.0 5C credit, so HMC values are divided by 3.
   */
  credits_5c: number;
  meetings: Meeting[];
  instructors: InstructorRef[];
  areas: AreaRef[];
  /**
   * Set only on pseudo-sections built from manual_courses (abroad, transfer,
   * create-your-own). Real catalog sections never have this.
   */
  manual?: { termLabel: string; kind: ManualCourseKind };
};

export type ManualCourseKind = "abroad" | "transfer" | "custom" | "planned" | "summer" | "credit";

/** Row from `manual_courses`. */
export type ManualCourse = {
  id: string;
  user_id: string;
  term_id: string | null;
  term_label: string;
  title: string;
  credits: number;
  kind: ManualCourseKind;
  note: string | null;
  created_at: string;
};

/* ------------------------------------------------------------------ */
/* Requirement matchers — stored as JSON in requirement_rules.match    */
/* ------------------------------------------------------------------ */

export type Matcher =
  /** Registrar course-area designation, e.g. {type:'area',codes:['3HUS']} */
  | { type: "area"; codes: string[] }
  /** Specific courses by term-independent code, e.g. 'CSCI 081 CM' */
  | { type: "course"; codes: string[] }
  /** A department, optionally bounded by course number, e.g. CSCI 100+ */
  | {
      type: "department";
      department: string;
      min?: number;
      max?: number;
      schools?: SchoolCode[];
    }
  /** Anything (used for 'free elective' style groups) */
  | { type: "any"; schools?: SchoolCode[] }
  /** Free text title match, for 'a course addressing X' style rules */
  | { type: "titleKeyword"; keywords: string[] }
  /** Match against the course TITLE only (descriptions mention other subjects). */
  | { type: "title"; keywords: string[] }
  /** Boolean combinators so a rule can say "CSCI 100+ but not CSCI 190" */
  | { type: "and"; children: Matcher[] }
  | { type: "or"; children: Matcher[] }
  | { type: "not"; child: Matcher };

export type RequirementRule = { id: number; match: Matcher };

export type RequirementGroup = {
  id: string;
  set_id: string;
  name: string;
  position: number;
  min_courses: number | null;
  min_credits: number | null;
  required: number;
  level: string;
  notes: string | null;
  rules: RequirementRule[];
  /** Courses that count as several toward this group (an accelerated course
   *  standing in for a two-semester sequence). See lib/sequences.ts. */
  worth?: { codes: string[]; counts: number; replaces: string[] }[];
};

export type RequirementSet = {
  id: string;
  school: SchoolCode;
  kind: "ge" | "major" | "minor" | "track";
  name: string;
  notes: string | null;
  source: string | null;
  verified: number;
  total_credits: number | null;
  degree_years: number | null;
  groups: RequirementGroup[];
};

/** A group evaluated against a student's planned courses. */
export type GroupProgress = {
  group: RequirementGroup;
  matched: Section[];
  neededCourses: number;
  neededCredits: number | null;
  haveCourses: number;
  haveCredits: number;
  /** 5C credits toward the requirement, counting a two-for-one course as the several courses it replaces. */
  effectiveCredits: number;
  satisfied: boolean;
  partial: boolean;
  /** Courses that count here but are 'overloaded' beyond what's needed. */
  excess: Section[];
  /** Sections the student/advisor locked into this group (manual assignment). */
  pinned: Section[];
};

export type SetProgress = {
  set: RequirementSet;
  groups: GroupProgress[];
  satisfiedGroups: number;
  totalGroups: number;
  percent: number;
  creditsPlanned: number;
  creditsRequired: number | null;
};

export type UserRow = {
  id: string;
  email: string;
  name: string;
  school: SchoolCode;
  grad_year: number | null;
  major_id: string | null;
  /** Double major — requirement set tracked alongside the first major. */
  major2_id: string | null;
  minor_id: string | null;
  /** Pre-health track (a requirement set of kind 'track'). */
  track_id: string | null;
  advisor: string | null;
};

export type ReviewRow = {
  id: string;
  instructor_id: string;
  section_id: string | null;
  stars: number;
  difficulty: number | null;
  workload: string | null;
  grade: string | null;
  take_again: number | null;
  text: string;
  tags: string;
  created_at: string;
  author: string;
  course_code: string | null;
};

export type InstructorSummary = {
  id: string;
  name: string;
  home_school: string | null;
  section_count: number;
  review_count: number;
  avg_stars: number | null;
  avg_difficulty: number | null;
  rmp_quality: number | null;
  rmp_difficulty: number | null;
  rmp_num_ratings: number | null;
  rmp_url: string | null;
  rmp_tags: string | null;
  /** When the RateMyProfessors figures were last loaded (ISO), or null. */
  rmp_synced_at: string | null;
};
