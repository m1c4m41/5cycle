/**
 * Counting-box rules — pure (no DB, no React) so the same checks run in the
 * browser (live greying-out), on the server (the action re-validates) and in
 * the page (building what the form needs).
 *
 * The rules, as students read them:
 *  1. GE boxes: a catalog course can only be checked toward a GE box it
 *     actually has (its course-area designation / rule match).
 *  2. Educational-Objective and Breadth-of-Knowledge boxes may share a course
 *     (one course can fill one of each) — but never two boxes inside the same
 *     one of those sections.
 *  3. Inside one major/minor a course fills only ONE box — once you pick it,
 *     that program's other boxes lock.
 *     Between programs (and GE↔program) the number of shareable courses is
 *     set by the student's campus — see OVERLAP_POLICY.
 *  4. Boxes the course doesn't match in a major/minor (advisor exceptions,
 *     study-abroad, "chosen with your advisor") can still be saved, after a
 *     warning that it only counts if the advisor/registrar approves it.
 */

export type BoxSection = "eo" | "breadth" | "other";

export type CountingGroup = {
  id: string;
  name: string;
  section: BoxSection;
  /** Does the course satisfy this group's rules on its own? */
  matches: boolean;
  /** Major/minor group that NAMES this exact course ("take CSCI 081"): it
   *  counts automatically — shown ticked and locked, no clicking needed. */
  auto?: boolean;
};

export type CountingSet = {
  id: string;
  name: string;
  kind: "ge" | "major" | "minor";
  groups: CountingGroup[];
};

export function boxSection(name: string): BoxSection {
  if (/breadth/i.test(name)) return "breadth";
  if (/educational objective/i.test(name)) return "eo";
  return "other";
}

/**
 * Double-counting policy by home campus. `null` = the college sets no fixed
 * number (department chairs / a committee decide case by case), so we don't
 * lock anything. Sources: Scripps' published "Double Counting Courses" policy;
 * CMC catalog (degree requirements / majors & sequences); Pitzer catalog
 * (field-group rules, "normally" language); Pomona and Harvey Mudd publish no
 * college-wide cap (chair/committee approval). Catalog language changes —
 * confirm with your registrar. Edit this table to change a campus's policy.
 */
export type OverlapPolicy = {
  /** Courses shareable between two majors. */
  majorMajor: number | null;
  majorMinor: number | null;
  minorMinor: number | null;
  /** Courses that may count toward a GE box AND a major/minor box (total). */
  geProgram: number | null;
  /** A course shared between two programs may not also count toward GE. */
  sharedExcludesGe?: boolean;
  /** Most requirements any one course may fill. */
  maxRequirements?: number;
  /** One line shown to the student. */
  summary: string;
};

export const OVERLAP_POLICY: Record<string, OverlapPolicy> = {
  SC: {
    majorMajor: 2,
    majorMinor: 1,
    minorMinor: 1,
    geProgram: null,
    sharedExcludesGe: true,
    maxRequirements: 2,
    summary:
      "Scripps: a course fills at most two requirements; up to 2 courses may double count between two majors, 1 between two minors, and 1 between a major and a minor (and then not also a General Requirement). More are allowed if each program has enough unduplicated courses (6 per major, 5 per minor) — not tracked here.",
  },
  CM: {
    majorMajor: 0,
    majorMinor: 1,
    minorMinor: 1,
    geProgram: 1,
    sharedExcludesGe: true,
    summary:
      "CMC: no course may count toward two majors; only one course may count toward both a major and a GE requirement (foreign language is the exception — not tracked here); a sequence/minor may share a course with a major or a GE requirement, but not both.",
  },
  PZ: {
    majorMajor: 2,
    majorMinor: 0,
    minorMinor: null,
    geProgram: null,
    summary:
      "Pitzer: normally up to 2 courses may overlap between two majors, and a minor normally shares no courses with a major — each field group can set or waive its own limit.",
  },
  PO: {
    majorMajor: null,
    majorMinor: null,
    minorMinor: null,
    geProgram: null,
    summary:
      "Pomona: no college-wide cap — each department sets its overlap rules for double majors and the chairs and Academic Procedures Committee approve them.",
  },
  HM: {
    majorMajor: null,
    majorMinor: null,
    minorMinor: null,
    geProgram: null,
    summary:
      "Harvey Mudd: no fixed cap — double counting between majors needs both department chairs' approval.",
  },
};
export const DEFAULT_POLICY: OverlapPolicy = {
  majorMajor: 1,
  majorMinor: 1,
  minorMinor: 1,
  geProgram: null,
  summary: "One course may be shared between any two programs.",
};
export const overlapPolicyFor = (school: string | null | undefined): OverlapPolicy =>
  (school && OVERLAP_POLICY[school]) || DEFAULT_POLICY;

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The cap for sharing a course between two sets (null = no fixed cap). */
function pairLimit(policy: OverlapPolicy, a: CountingSet, b: CountingSet): number | null {
  if (a.kind === "ge" && b.kind === "ge") return null;
  if (a.kind === "ge" || b.kind === "ge") return policy.geProgram;
  if (a.kind === "major" && b.kind === "major") return policy.majorMajor;
  if (a.kind === "minor" && b.kind === "minor") return policy.minorMinor;
  return policy.majorMinor;
}

/** Why a box can't be ticked right now (null = it can). */
export function boxBlockReason(args: {
  set: CountingSet;
  group: CountingGroup;
  /** Manual / study-abroad courses have no designations, so GE boxes are not
   *  strictly blocked for them (they go through the advisor-warning path). */
  strictGe: boolean;
  half: boolean;
  checked: Set<string>;
  policy: OverlapPolicy;
  /** How many OTHER courses already share each pair of sets ("setA|setB"). */
  pairUse: Record<string, number>;
  sets: CountingSet[];
}): string | null {
  const { set, group, strictGe, half, policy, pairUse, sets } = args;
  if (group.auto) {
    return "This program lists this exact course as a requirement, so it counts here automatically.";
  }
  if (args.checked.has(group.id)) return null; // always allow un-ticking
  // Automatically counted boxes behave as already ticked for every rule below.
  const checked = new Set(args.checked);
  for (const s of sets) for (const g of s.groups) if (g.auto) checked.add(g.id);

  if (half && (set.kind === "ge" || group.section === "breadth")) {
    return "0.5-credit courses can’t count toward a GE or Breadth box — a full credit is needed. Its credits still count toward your graduation total.";
  }
  if (set.kind === "ge" && strictGe && !group.matches) {
    return "This course doesn’t carry this GE designation, so it can’t count here.";
  }
  // Major/minor: one course fills only ONE requirement box inside a program.
  if (set.kind !== "ge") {
    const taken = set.groups.find((g) => g.id !== group.id && checked.has(g.id));
    if (taken) {
      return `Already counting toward “${taken.name}” — a course can fill only one requirement inside the same ${set.kind}.`;
    }
  }
  // GE: only one Educational-Objective box and one Breadth box.
  if (group.section !== "other") {
    const clash = set.groups.find(
      (g) => g.id !== group.id && g.section === group.section && checked.has(g.id),
    );
    if (clash) {
      return `Already counting toward “${clash.name}” — a course can fill only one ${
        group.section === "breadth" ? "Breadth-of-Knowledge" : "Educational-Objective"
      } box.`;
    }
  }
  // Campus caps on how many courses may be shared between two programs.
  const ticked = sets.filter((s) => s.id !== set.id && s.groups.some((g) => checked.has(g.id)));
  for (const other of ticked) {
    const limit = pairLimit(policy, set, other);
    if (limit === null) continue;
    if ((pairUse[pairKey(set.id, other.id)] ?? 0) >= limit) {
      return limit === 0
        ? `${policy.summary.split(":")[0]} doesn’t allow a course to count toward both ${set.name} and ${other.name}.`
        : `Your campus’s limit of ${limit} shared course${limit === 1 ? "" : "s"} between ${set.name} and ${other.name} is already used by other courses.`;
    }
  }
  // Scripps: at most N requirements per course; a program-shared course can't also be GE.
  const tickedSets = sets.filter((s) => s.groups.some((g) => checked.has(g.id)) || s.id === set.id);
  if (policy.maxRequirements) {
    const count = sets.reduce((n, s) => n + s.groups.filter((g) => checked.has(g.id)).length, 0);
    if (count >= policy.maxRequirements) {
      return `A course may fill at most ${policy.maxRequirements} requirements here.`;
    }
  }
  if (policy.sharedExcludesGe) {
    const programs = tickedSets.filter((s) => s.kind !== "ge").length;
    const geTicked = tickedSets.some((s) => s.kind === "ge");
    if (programs >= 2 && geTicked) {
      return "A course shared between two programs can’t also count toward a General Requirement.";
    }
  }
  return null;
}

/** Boxes that are ticked but don't match the course (advisor-exception path). */
export function nonMatching(sets: CountingSet[], checked: Set<string>): { set: CountingSet; group: CountingGroup }[] {
  const out: { set: CountingSet; group: CountingGroup }[] = [];
  for (const set of sets)
    for (const group of set.groups)
      if (checked.has(group.id) && !group.matches && !group.auto) out.push({ set, group });
  return out;
}

/** Server-side re-check of a submitted selection. */
export function validateCounting(args: {
  sets: CountingSet[];
  strictGe: boolean;
  checkedIds: string[];
  policy: OverlapPolicy;
  pairUse: Record<string, number>;
}): { ok: true } | { ok: false; error: string } {
  const { sets, strictGe, policy, pairUse } = args;
  // Auto-counted boxes need no saving; ignore them if a form sends one.
  const autoIds = new Set(sets.flatMap((s) => s.groups.filter((g) => g.auto).map((g) => g.id)));
  const checked = new Set(args.checkedIds.filter((id) => !autoIds.has(id)));
  const known = new Set(sets.flatMap((s) => s.groups.map((g) => g.id)));
  for (const id of checked) {
    if (!known.has(id)) {
      return { ok: false, error: "One of those boxes isn’t part of your programs — reload and try again." };
    }
  }
  for (const set of sets) {
    for (const group of set.groups) {
      if (!checked.has(group.id)) continue;
      // Evaluate each box against the rest of the selection.
      const rest = new Set(checked);
      rest.delete(group.id);
      const why = boxBlockReason({ set, group, strictGe, half: false, checked: rest, policy, pairUse, sets });
      if (why) return { ok: false, error: `“${group.name}”: ${why}` };
    }
  }
  return { ok: true };
}
