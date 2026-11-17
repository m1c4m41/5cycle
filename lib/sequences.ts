/**
 * Two-for-one courses: an accelerated / integrated course that a program
 * explicitly lists as an alternative to a two-semester sequence satisfies the
 * WHOLE sequence — e.g. CHEM 029L KS (Accelerated General Chemistry) replaces
 * CHEM 014L KS + CHEM 015L KS. The engine reads `worth` and counts such a
 * course as that many courses toward the group.
 *
 * Keyed by requirement-group id. Only groups whose catalog text states the
 * standalone alternative are listed; `minCourses` fixes groups the importer
 * flattened to "1 course" even though the written requirement is the
 * two-course sequence.
 *
 * Audited across all five campuses against the stored requirement text.
 * Harvey Mudd and CMC list no accelerated alternatives in their synced
 * requirement sets. Pomona's only one is CHEM 050 PO; the rest are the Keck
 * Science courses taught at Pitzer/Scripps.
 */
import type { RequirementGroup } from "./types";

/** `counts`: how many courses it stands in for. `replaces`: the exact sequence
 *  it substitutes for — it counts for THOSE courses only, and they stop counting
 *  separately in that group once it has filled their place. */
type Worth = Record<string, { counts: number; replaces: string[] }>;
type Override = { minCourses?: number; worth: Worth };

const KS_GENCHEM = ["CHEM 014L KS", "CHEM 015L KS"];
const PO_GENCHEM = ["CHEM 010A PO", "CHEM 010B PO", "CHEM 020A PO", "CHEM 020B PO"];
const CHEM_029 = { "CHEM 029L KS": { counts: 2, replaces: KS_GENCHEM } };
const CHEM_BOTH: Worth = { ...CHEM_029, "CHEM 042L KS": { counts: 2, replaces: KS_GENCHEM } };
const PO_050: Worth = { "CHEM 050 PO": { counts: 2, replaces: PO_GENCHEM } };

export const SEQUENCE_OVERRIDES: Record<string, Override> = {
  // Pitzer
  "major-PZ-CHEM::general-chemistry-sequence": { worth: CHEM_BOTH },
  "major-PZ-BPYS::chemistry": { worth: CHEM_BOTH },
  "major-PZ-MOLB::general-chemistry": { worth: CHEM_BOTH },
  "major-PZ-SMGT::general-chemistry": { minCourses: 2, worth: CHEM_BOTH },
  "major-PZ-BIOL::chemistry-foundation": { worth: CHEM_029 },
  "major-PZ-BCHM::chemistry-requirements": { worth: CHEM_BOTH },
  "major-PZ-ORGB::foundations": { worth: CHEM_BOTH },
  "major-PZ-NEUR::common-core-biology-and-chemistry": { worth: CHEM_029 },
  "minor-PZ-BIOL::general-chemistry": { worth: CHEM_BOTH },
  "minor-PZ-CHEM::introductory-chemistry": { worth: CHEM_029 },
  // Scripps
  "major-SC-BIOC::general-chemistry": { minCourses: 2, worth: CHEM_029 },
  "major-SC-BIOL-ORG::chemistry": { minCourses: 2, worth: CHEM_BOTH },
  "major-SC-CHEM::general-chemistry": { minCourses: 2, worth: CHEM_BOTH },
  "major-SC-SMGT::general-chemistry": { minCourses: 2, worth: CHEM_BOTH },
  "major-SC-ARCNCH::foundation-art-history-and-general-chemistry": { worth: CHEM_029 },
  "major-SC-ARCNS::foundation-art-history-and-general-chemistry": { worth: CHEM_029 },
  "minor-SC-ARCN::foundation-art-history-and-general-chemistry": { minCourses: 3, worth: CHEM_029 },
  "minor-SC-BIOL::general-chemistry": { minCourses: 2, worth: CHEM_BOTH },
  "minor-SC-CHEM::introductory-chemistry": { minCourses: 2, worth: CHEM_029 },
  // Pomona
  "major-PO-CHEM::chemistry-two-semesters-of-general-chemistry-chem010a-po-chem010b-po-or-chem020a-po-chem020b-po-or-chem050-po":
    { worth: PO_050 },
  "minor-PO-CHEM::chem010a-po-chem010b-po-or-chem020a-po-and-chem020b-po-or-chem050-po": {
    minCourses: 2,
    worth: PO_050,
  },
  "major-PO-PHYS::chem010a-po-chem010b-po-or-chem050-po": { minCourses: 2, worth: PO_050 },
};

/** Attach worth + corrected course counts to a group loaded from the DB. */
export function applySequenceOverrides(g: RequirementGroup): RequirementGroup {
  const o = SEQUENCE_OVERRIDES[g.id];
  if (!o) return g;
  return {
    ...g,
    min_courses: o.minCourses ?? g.min_courses,
    worth: Object.entries(o.worth).map(([code, w]) => ({ codes: [code], ...w })),
  };
}
