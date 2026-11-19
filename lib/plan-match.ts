/**
 * Auto-swap for "📌 want to take" placeholders: when a real section that fits a
 * placeholder is added to the plan ("ochem" → CHEM 116L Organic Chemistry), the
 * placeholder is removed. Only swaps when exactly one placeholder fits; if it's
 * ambiguous, nothing happens and the student removes the pin by hand.
 */
import { all, run } from "./db";
import type { Section } from "./types";

type Plan = { id: string; term_id: string | null; term_label: string; title: string };

const ALIASES: Record<string, string[]> = {
  ochem: ["organic", "chemistry"],
  orgo: ["organic", "chemistry"],
  biochem: ["biochemistry"],
  gchem: ["general", "chemistry"],
  stats: ["statistics"],
  stat: ["statistics"],
  calc: ["calculus"],
  psych: ["psychology"],
  econ: ["economics"],
  neuro: ["neuroscience"],
  cs: ["computer", "science"],
  comp: ["computer"],
  poli: ["political"],
  anthro: ["anthropology"],
  socio: ["sociology"],
  phys: ["physics"],
  lit: ["literature"],
};
const STOP = new Set(["intro", "introduction", "to", "of", "and", "the", "a", "an", "for", "in", "i", "ii", "iii", "w", "with", "class", "course"]);

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function termOfLabel(label: string): string | null {
  const m = /(Fall|Spring|Summer)\s+(\d{4})/i.exec(label);
  if (!m) return null;
  const s = m[1].toLowerCase();
  return `${s === "fall" ? "FA" : s === "spring" ? "SP" : "SU"}${m[2]}`;
}

export function planFitsSection(plan: Plan, s: Section): boolean {
  const planTerm = plan.term_id ?? termOfLabel(plan.term_label);
  if (planTerm && planTerm !== s.term_id) return false;

  // "CHEM 116" / "chem116l" — department + number is a strong match.
  const code = /\b([a-z]{2,5})\s*0*(\d{1,3})[a-z]{0,2}\b/i.exec(plan.title);
  if (code && code[1].toUpperCase() === s.department.toUpperCase() && Number(code[2]) === s.course_number) {
    return true;
  }

  // Name match: every meaningful word of the placeholder starts a word of the title.
  const planWords = words(plan.title)
    .filter((w) => !STOP.has(w) && !/^\d+$/.test(w))
    .flatMap((w) => ALIASES[w] ?? [w]);
  if (planWords.length === 0) return false;
  const titleWords = words(s.title);
  return planWords.every((p) =>
    titleWords.some((t) => (p.length >= 4 ? t.startsWith(p) : t === p)),
  );
}

/** Remove the single placeholder that fits `section`; returns its title (or null). */
export async function swapPlannedFor(userId: string, section: Section): Promise<string | null> {
  const plans = await all<Plan>(
    "SELECT id, term_id, term_label, title FROM manual_courses WHERE user_id = ? AND kind = 'planned'",
    [userId],
  );
  const fits = plans.filter((p) => planFitsSection(p, section));
  if (fits.length !== 1) return null; // none, or too ambiguous to guess
  await run("DELETE FROM manual_courses WHERE id = ? AND user_id = ?", [fits[0].id, userId]);
  return fits[0].title;
}
