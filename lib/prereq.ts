/**
 * Prerequisites are not a separate field in the registrar feed — they live in
 * the course description ("Prerequisite: CSCI 060 or permission."). Pull that
 * sentence out so the catalog card can show it up front.
 */

// "Prerequisite(s):", "Prerequisites", "Prereq:", "Pre-req", plus the typos
// that really appear in the feed (Prerequistis, Prerequisitie, Prerequsite…).
// Capitalized, or lowercase only when followed by a colon, so "not a
// prerequisite for this course" is not picked up.
const MARKER = /\b(?:Pre-?req\w*|pre-?req\w*(?=\s*:))(?:\(s\))?\s*(?::|\.|\bare\b|\bis\b)?\s*/;
const ABBREV = /(?:\b(?:equiv|dept|prof|inst|instr|st|dr|no|sr|jr|vs|approx|e\.g|i\.e)|\b[A-Z])$/i;
const MAX = 220;

export function extractPrerequisites(description: string | null | undefined): string | null {
  if (!description) return null;
  const text = description.replace(/\s+/g, " ");
  const m = MARKER.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);

  // Sentence end: ". " followed by a capital, unless the period closes an abbreviation.
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "." ) continue;
    const after = rest.slice(i + 1);
    if (after.length && !/^\s+[A-Z]/.test(after)) continue;
    if (ABBREV.test(rest.slice(0, i))) continue;
    end = i;
    break;
  }
  let out = rest.slice(0, end).replace(/[\s.;,]+$/, "").trim();
  if (!out || /^(none|n\/?a|no|not applicable)\b\.?$/i.test(out)) return null;
  if (out.length > MAX) out = out.slice(0, MAX).replace(/\s+\S*$/, "") + "…";
  return out;
}
