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
 *     A course may count toward GE *and* a major/minor freely. Between two
 *     programs (major↔major, major↔minor, minor↔minor) only ONE course may be
 *     shared in total.
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
 * How many courses a student may share between two programs (major↔major,
 * major↔minor, minor↔minor), by home campus. Scripps allows two; the other
 * campuses default to one and require department/committee sign-off beyond
 * that. Edit this table to change a campus's policy.
 */
export const OVERLAP_LIMIT: Record<string, number> = { SC: 2 };
export const DEFAULT_OVERLAP_LIMIT = 1;
export const overlapLimitFor = (school: string | null | undefined): number =>
  (school && OVERLAP_LIMIT[school]) || DEFAULT_OVERLAP_LIMIT;

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Why a box can't be ticked right now (null = it can). */
export function boxBlockReason(args: {
  set: CountingSet;
  group: CountingGroup;
  /** Manual / study-abroad courses have no designations, so GE boxes are not
   *  strictly blocked for them (they go through the advisor-warning path). */
  strictGe: boolean;
  half: boolean;
  checked: Set<string>;
  /** Overlap allowances other courses already use ("setA|setB"). */
  usedPairs: Set<string>;
  sets: CountingSet[];
}): string | null {
  const { set, group, strictGe, half, checked, usedPairs, sets } = args;
  if (checked.has(group.id)) return null; // always allow un-ticking

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
  // Between programs: one shared course per pair.
  if (set.kind !== "ge") {
    for (const other of sets) {
      if (other.id === set.id || other.kind === "ge") continue;
      if (!other.groups.some((g) => checked.has(g.id))) continue;
      if (usedPairs.has(pairKey(set.id, other.id))) {
        return `Another course already overlaps ${set.name} and ${other.name} — your campus’s shared-course limit is used up.`;
      }
    }
  }
  return null;
}

/** Boxes that are ticked but don't match the course (advisor-exception path). */
export function nonMatching(sets: CountingSet[], checked: Set<string>): { set: CountingSet; group: CountingGroup }[] {
  const out: { set: CountingSet; group: CountingGroup }[] = [];
  for (const set of sets)
    for (const group of set.groups) if (checked.has(group.id) && !group.matches) out.push({ set, group });
  return out;
}

/** Server-side re-check of a submitted selection. */
export function validateCounting(args: {
  sets: CountingSet[];
  strictGe: boolean;
  checkedIds: string[];
  usedPairs: Set<string>;
}): { ok: true } | { ok: false; error: string } {
  const { sets, strictGe, usedPairs } = args;
  const checked = new Set(args.checkedIds);
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
      const why = boxBlockReason({ set, group, strictGe, half: false, checked: rest, usedPairs, sets });
      if (why) return { ok: false, error: `“${group.name}”: ${why}` };
    }
  }
  return { ok: true };
}
