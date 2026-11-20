/**
 * "Fill my gaps": classes for a term that (a) fit the empty slots on the
 * student's weekly grid and (b) advance a requirement they still need —
 * major/minor requirements first, then GE.
 *
 * Works from three cheap term-wide reads (sections without descriptions, area
 * codes, meeting times) so the whole term can be scanned without hydrating
 * thousands of sections; only the winners are hydrated at the end.
 */
import { all } from "./db";
import { getSectionsByIds, THESIS_TITLE_RE } from "./catalog";
import { enrolledSections } from "./schedule";
import {
  assignmentsFor,
  groupMatches,
  isBreadthGroup,
  manualCoursesFor,
  manualPseudoSection,
  progressForUser,
} from "./requirements";
import { overlaps } from "./util";
import type { Meeting, RequirementGroup, RequirementSet, Section, SectionRow } from "./types";

export type NeedTier = "major" | "minor" | "ge";

export type GapPick = {
  section: Section;
  /** Strongest requirement this class advances. */
  tier: NeedTier;
  /** "Major: Computer Science — Upper-division electives", … */
  reasons: string[];
};

export type GapResult = {
  picks: GapPick[];
  /** Requirement boxes still open, for the explanatory banner. */
  openGroups: number;
  /** Classes already on the grid this term. */
  plannedCount: number;
};

type UnmetGroup = { set: RequirementSet; group: RequirementGroup };

const TIER_WEIGHT: Record<NeedTier, number> = { major: 100, minor: 90, ge: 50 };

function meetingsClash(a: Meeting[], b: Meeting[]): boolean {
  for (const ma of a)
    for (const mb of b) {
      if (![...ma.days].some((d) => mb.days.includes(d))) continue;
      if (overlaps(ma.start_time, ma.end_time, mb.start_time, mb.end_time)) return true;
    }
  return false;
}

/** Free electives / "any course" boxes would match everything — not a gap to fill. */
function isOpenEnded(g: RequirementGroup): boolean {
  return g.rules.some((r) => r.match.type === "any");
}

export async function findGapFillers(
  user: { id: string; school: string; major_id: string | null; major2_id?: string | null; minor_id: string | null; track_id?: string | null },
  term: string,
  limit = 24,
  /** Sections the student added from this very list: they stay listed (with a
   *  remove button) instead of vanishing once they're in the plan. */
  keepIds: string[] = [],
): Promise<GapResult> {
  const [termPlanned, allPlanned, manuals, assignments] = await Promise.all([
    enrolledSections(user.id, term),
    enrolledSections(user.id),
    manualCoursesFor(user.id),
    assignmentsFor(user.id),
  ]);
  const plannedAll: Section[] = [
    ...allPlanned,
    ...manuals.map((m) => manualPseudoSection(m, user.school as never)),
  ];

  // Which boxes are still open, across GE + major(s) + minor.
  const progress = await progressForUser(user as never, plannedAll, { assignments });
  const unmet: UnmetGroup[] = [];
  const every: UnmetGroup[] = []; // all fixed boxes — kept classes may have just closed one
  for (const p of progress)
    for (const gp of p.groups) {
      if (gp.group.required === 0 || isOpenEnded(gp.group)) continue;
      every.push({ set: p.set, group: gp.group });
      if (!gp.satisfied) unmet.push({ set: p.set, group: gp.group });
    }
  const keep = new Set(keepIds.filter((id) => termPlanned.some((s) => s.id === id)));
  if (unmet.length === 0 && keep.size === 0)
    return { picks: [], openGroups: 0, plannedCount: termPlanned.length };

  // Term-wide light reads.
  const [rows, areaRows, meetRows] = await Promise.all([
    all<SectionRow>(
      `SELECT id, term_id, department, course_number, suffix, affiliation, section_number, half,
              code_string, course_code, title, '' AS description, school, credits, perm_count,
              seats_total, seats_filled, status, start_date, end_date, potential_error, '' AS search
       FROM sections WHERE term_id = ?`,
      [term],
    ),
    all<{ section_id: string; code: string }>(
      `SELECT sa.section_id AS section_id, sa.area_code AS code
       FROM section_areas sa JOIN sections s ON s.id = sa.section_id WHERE s.term_id = ?`,
      [term],
    ),
    all<{ section_id: string } & Meeting>(
      `SELECT ss.section_id AS section_id, ss.days, ss.start_time, ss.end_time, ss.locations
       FROM section_schedules ss JOIN sections s ON s.id = ss.section_id WHERE s.term_id = ?`,
      [term],
    ),
  ]);
  const areasBy = new Map<string, string[]>();
  for (const a of areaRows) (areasBy.get(a.section_id) ?? areasBy.set(a.section_id, []).get(a.section_id)!).push(a.code);
  const meetBy = new Map<string, Meeting[]>();
  for (const m of meetRows)
    (meetBy.get(m.section_id) ?? meetBy.set(m.section_id, []).get(m.section_id)!).push(m);

  const plannedIds = new Set(termPlanned.map((s) => s.id));
  const takenCodes = new Set(plannedAll.map((s) => s.course_code).filter(Boolean));
  const gridMeetings = termPlanned.flatMap((s) => s.meetings);

  type Cand = { row: SectionRow; hits: UnmetGroup[]; score: number; tier: NeedTier };
  const best = new Map<string, Cand>(); // one section per course

  for (const row of rows) {
    const meetings = meetBy.get(row.id);
    if (!meetings?.length) continue; // TBA — can't be placed on the grid
    const kept = keep.has(row.id);
    if (!kept) {
      if (plannedIds.has(row.id) || takenCodes.has(row.course_code)) continue;
      if (row.potential_error) continue;
      if (gridMeetings.length && meetingsClash(meetings, gridMeetings)) continue; // doesn't fit the grid
    }

    const credits5c = row.school === "HM" ? row.credits / 3 : row.credits;
    if (credits5c <= 0) continue;
    const light = {
      ...row,
      credits_5c: credits5c,
      meetings,
      instructors: [],
      areas: (areasBy.get(row.id) ?? []).map((code) => ({ code, description: "", kind: "", school: null })),
    } as unknown as Section;

    const hits = (kept ? every : unmet).filter(({ set, group }) => {
      if (credits5c < 1 && (set.kind === "ge" || isBreadthGroup(group))) return false;
      return groupMatches(group, light);
    });
    if (hits.length === 0) continue;

    const tier: NeedTier = hits.some((h) => h.set.kind === "major")
      ? "major"
      : hits.some((h) => h.set.kind === "minor" || h.set.kind === "track")
        ? "minor"
        : "ge";
    const open = row.status === "O" || row.status === "R";
    // Thesis / senior-project sections go last: students pick those on their own.
    const score =
      TIER_WEIGHT[tier] + 5 * Math.min(hits.length, 4) + (open ? 4 : 0) -
      (THESIS_TITLE_RE.test(row.title) ? 1000 : 0);

    const prev = best.get(row.course_code);
    // A kept class always wins over other sections of its own course.
    if (!prev || kept || (score > prev.score && !keep.has(prev.row.id)))
      best.set(row.course_code, { row, hits, score, tier });
  }

  const bySort = (a: Cand, b: Cand) =>
    b.score - a.score || a.row.course_code.localeCompare(b.row.course_code);
  const all_ = [...best.values()];
  const ranked = [
    ...all_.filter((c) => !keep.has(c.row.id)).sort(bySort).slice(0, limit),
    ...all_.filter((c) => keep.has(c.row.id)),
  ].sort(bySort);

  // Hydrate just the winners and re-check with full text (descriptions matter
  // for title-keyword rules) before showing them.
  const hydrated = await getSectionsByIds(ranked.map((c) => c.row.id));
  const byId = new Map(hydrated.map((s) => [s.id, s]));
  const picks: GapPick[] = [];
  for (const c of ranked) {
    const section = byId.get(c.row.id);
    if (!section) continue;
    const hits = c.hits.filter(({ group }) => groupMatches(group, section));
    if (hits.length === 0) continue;
    const label = (k: string) => (k === "ge" ? "GE" : k === "major" ? "Major" : "Minor");
    picks.push({
      section,
      tier: c.tier,
      reasons: [...hits]
        .sort((a, b) => TIER_WEIGHT[b.set.kind as NeedTier] - TIER_WEIGHT[a.set.kind as NeedTier])
        .map(({ set, group }) => `${label(set.kind)} · ${set.name}: ${group.name}`),
    });
  }
  return { picks, openGroups: unmet.length, plannedCount: termPlanned.length };
}
