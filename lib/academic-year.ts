/**
 * Academic years at the 5Cs run Fall → Spring (→ Summer): the 2026–27 year is
 * FA2026, SP2027 and SU2027. The "current" year follows the current term, so it
 * rolls over by itself when the calendar flips to a new fall.
 */
export type AcademicYear = {
  /** First calendar year, e.g. 2026 for 2026–27. */
  start: number;
  /** "2026–27" */
  label: string;
  /** Term ids that belong to the year, chronological. */
  termIds: string[];
};

export function academicYearOf(termId: string): AcademicYear | null {
  const m = /^(FA|SP|SU)(\d{4})$/.exec(termId);
  if (!m) return null;
  const year = Number(m[2]);
  const start = m[1] === "FA" ? year : year - 1;
  return {
    start,
    label: `${start}–${String(start + 1).slice(2)}`,
    termIds: [`FA${start}`, `SP${start + 1}`, `SU${start + 1}`],
  };
}
