/**
 * Pre-health tracks (pre-med, pre-dental, pre-PA, pre-nursing) as requirement
 * sets of kind "track". They are not campus-specific, so they are stored with
 * school "CG" and are built in code (loaded by ensureBuiltinSets in
 * lib/requirements.ts) rather than from data/requirements.
 *
 * Course rules match on TITLES (a course description can mention any subject),
 * so they are approximate: "verified" stays false and every set tells the
 * student to confirm with their pre-health advisor and target schools.
 * Non-course requirements (entrance exam, clinical hours, how much of it is
 * available on the 5Cs) are written into the set notes.
 */
import type { Matcher } from "./types";

export type TrackGroup = {
  name: string;
  minCourses?: number;
  required?: boolean;
  notes?: string;
  matchers: Matcher[];
};
export type TrackSet = {
  id: string;
  name: string;
  notes: string;
  groups: TrackGroup[];
};

const title = (...keywords: string[]): Matcher => ({ type: "title", keywords });
const dept = (department: string, min?: number, max?: number): Matcher => ({ type: "department", department, min, max });
const and = (...children: Matcher[]): Matcher => ({ type: "and", children });
const or = (...children: Matcher[]): Matcher => ({ type: "or", children });
const not = (child: Matcher): Matcher => ({ type: "not", child });

// A lab-only section ("Lab, General Chemistry", "…Chem Lab") is not its own course.
const notLabOnly = not(title("Lab,", "Chem Lab", "Physics Lab", "Biology Lab", "Laboratory,"));

const GEN_BIO: TrackGroup = {
  name: "General Biology — 1 year",
  minCourses: 2,
  matchers: [
    and(
      dept("BIOL", undefined, 60),
      title("Intro", "Concepts in Biology", "Integrated Biology"),
      notLabOnly,
      not(title("Python", "Recitation", "Lab 1", "Lab 2", "Genetics")),
    ),
  ],
};
const GEN_CHEM: TrackGroup = {
  name: "General Chemistry — 1 year",
  minCourses: 2,
  matchers: [
    and(
      dept("CHEM", undefined, 60),
      title("General Chem", "Gen Chem", "Discovering Chem", "Basic Principles of Chem", "Integrated Biology"),
      notLabOnly,
    ),
  ],
};
const ORGO: TrackGroup = {
  name: "Organic Chemistry — 1 year",
  minCourses: 2,
  matchers: [
    and(
      dept("CHEM"),
      title("Organic Chem"),
      not(title("Inorganic", "Lab,", "Laboratory", "Advanced", "Chemistry Lab")),
    ),
    // Pomona/CMC list the lab inside the course title.
    and(dept("CHEM"), title("Organic Chemistry w/Lab", "Organic Chemistry with Lab")),
  ],
};
const PHYSICS: TrackGroup = {
  name: "Physics — 1 year",
  minCourses: 2,
  matchers: [
    and(
      dept("PHYS"),
      title("General Physics", "Principles of Physics", "Mechanics & Wave", "Electromagnetic Theory"),
      notLabOnly,
    ),
  ],
};
const BIOCHEM: TrackGroup = {
  name: "Biochemistry — 1 semester",
  matchers: [
    and(
      or(dept("BIOL"), dept("CHEM")),
      title("Biochemistry"),
      not(title("Lab,", "Advanced Lab", "Biochemistry Laboratory", "Topics")),
    ),
  ],
};
const CALCULUS: TrackGroup = { name: "Calculus — 1 semester", matchers: [and(dept("MATH"), title("Calculus"))] };
const STATS: TrackGroup = {
  name: "Statistics — 1 semester",
  matchers: [and(title("Statistics", "Biostatistics"), not(title("Computational", "Bayesian", "Senior", "Seminar")))],
};
const ENGLISH: TrackGroup = {
  name: "English / Writing — 1 year",
  minCourses: 2,
  matchers: [or(dept("ENGL"), dept("WRIT"), dept("ENG"), dept("LIT"), dept("FWS"))],
};
const INTRO_PSYCH: TrackGroup = {
  name: "Introductory Psychology",
  matchers: [
    and(dept("PSYC"), title("Introduction to Psych", "Intro to Psych", "Intro Psych", "Introduction to Psychology"), notLabOnly),
  ],
};
const SOCIOLOGY: TrackGroup = {
  name: "Introductory Sociology",
  matchers: [or(dept("SOC", undefined, 99), and(dept("SOC"), title("Introduction to Sociology", "Intro to Sociology")))],
};
const ANATOMY: TrackGroup = {
  name: "Human Anatomy",
  matchers: [and(title("Anatomy"), not(dept("ART")))],
};
const PHYSIOLOGY: TrackGroup = { name: "Human Physiology", matchers: [title("Physiology")] };
const MICRO: TrackGroup = { name: "Microbiology", matchers: [title("Microbiology")] };
const GENETICS: TrackGroup = { name: "Genetics", matchers: [and(title("Genetics"), not(title("Population")))] };
const DEVELOPMENTAL: TrackGroup = {
  name: "Lifespan / Developmental Psychology",
  matchers: [title("Developmental Psych", "Lifespan", "Life Span", "Child Development", "Human Development", "Adolescen")],
};
const NUTRITION: TrackGroup = { name: "Nutrition", matchers: [title("Nutrition")] };

const optional = (g: TrackGroup, name?: string, notes?: string): TrackGroup => ({
  ...g,
  name: name ?? g.name,
  required: false,
  notes,
});

const ADVISOR =
  "Science courses are expected with their labs. Requirements vary by school: confirm the list with your pre-health advisor and the programs you are applying to. Course matching here is by title and approximate.";

export const PREHEALTH_SETS: TrackSet[] = [
  {
    id: "track-premed",
    name: "Pre-Med (MD/DO)",
    notes:
      `${ADVISOR} Entrance exam: MCAT. Clinical experience: about 100–200+ hours of clinical volunteering and physician shadowing. ` +
      "5C availability: about 100% on campus (Pomona, HMC, or the joint science departments).",
    groups: [
      GEN_BIO,
      GEN_CHEM,
      ORGO,
      PHYSICS,
      BIOCHEM,
      ENGLISH,
      CALCULUS,
      STATS,
      INTRO_PSYCH,
      SOCIOLOGY,
      optional(
        { name: "", minCourses: 1, matchers: [and(or(dept("BIOL"), dept("NEUR")), title("Cell Bio", "Genetics", "Physiology", "Molecular"))] },
        "Recommended: Cell Biology, Genetics or Physiology",
        "Not strictly required, but they help for the MCAT.",
      ),
    ],
  },
  {
    id: "track-predental",
    name: "Pre-Dental (DDS/DMD)",
    notes:
      `${ADVISOR} Entrance exam: DAT (Dental Admission Test). Clinical experience: about 100+ hours of shadowing a general dentist. ` +
      "5C availability: about 95% on campus (you may need Microbiology or Anatomy off campus, depending on target schools).",
    groups: [
      GEN_BIO,
      GEN_CHEM,
      ORGO,
      PHYSICS,
      BIOCHEM,
      ENGLISH,
      STATS,
      {
        name: "Psychology or Sociology — 1 semester",
        matchers: [or(and(dept("PSYC"), title("Intro")), dept("SOC"))],
      },
      optional(
        { name: "", minCourses: 2, matchers: [or(title("Microbiology"), title("Anatomy"), title("Physiology"))] },
        "Recommended: Microbiology, Anatomy or Physiology",
        "Many dental schools recommend these.",
      ),
      optional(
        { name: "", matchers: [title("Sculpt", "3D", "3-D", "Three-Dim", "Ceramic")] },
        "Recommended: a 3D art / sculpting course",
        "Often suggested for manual dexterity.",
      ),
    ],
  },
  {
    id: "track-prepa",
    name: "Pre-PA (Physician Assistant)",
    notes:
      `${ADVISOR} Entrance exam: GRE or PA-CAT (optional or waived at many programs). ` +
      "Clinical experience: strict requirement of about 1,000–2,000+ hours of hands-on, paid direct patient care (for example EMT, CNA, MA). " +
      "5C availability: about 70% on campus (Anatomy & Physiology and Microbiology are often taken at a local community college such as Citrus or Mt. SAC).",
    groups: [
      GEN_BIO,
      GEN_CHEM,
      { name: "Organic Chemistry or Biochemistry — 1 semester", matchers: [...ORGO.matchers, ...BIOCHEM.matchers] },
      ANATOMY,
      PHYSIOLOGY,
      MICRO,
      GENETICS,
      STATS,
      { ...INTRO_PSYCH, name: "Psychology — introductory" },
      optional(DEVELOPMENTAL, "Second psychology: Abnormal or Lifespan/Developmental", "1–2 semesters of psychology are expected."),
    ],
  },
  {
    id: "track-prenursing",
    name: "Pre-Nursing (ABSN / Direct-Entry MSN)",
    notes:
      `${ADVISOR} Entrance exam: TEAS or HESI A2 (some Direct-Entry MSN programs ask for the GRE). ` +
      "Clinical experience: nurse shadowing and general healthcare volunteering recommended (no strict paid-hour minimum). " +
      "5C availability: about 50% on campus (Anatomy & Physiology, Microbiology and Nutrition are typically taken at a local community college).",
    groups: [
      { name: "General Chemistry — 1 semester", matchers: GEN_CHEM.matchers },
      { name: "Introductory Biology — 1 semester", matchers: GEN_BIO.matchers },
      ANATOMY,
      PHYSIOLOGY,
      MICRO,
      STATS,
      DEVELOPMENTAL,
      SOCIOLOGY,
      NUTRITION,
    ],
  },
];

export const TRACK_IDS = PREHEALTH_SETS.map((s) => s.id);
