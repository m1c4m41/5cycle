/**
 * RateMyProfessors data.
 *
 * IMPORTANT: RateMyProfessors publishes **no public API**, and automated
 * access is against its terms of service. 5Cycle therefore does not scrape
 * it — the live mirror was removed for public use. The mirrored RMP columns
 * are populated only by a curated local import (data/rmp-manual.json, no
 * network involved), and every page falls back to a plain RMP search link
 * rather than inventing a number.
 */
import fs from "node:fs";
import path from "node:path";
import { get, run } from "./db";
import { normalizeName } from "./util";

/** RateMyProfessors school ids for the five colleges (from each school's RMP page). */
export const RMP_SCHOOL_ID: Record<string, number> = {
  CM: 234, // Claremont McKenna College
  HM: 400, // Harvey Mudd College
  PZ: 768, // Pitzer College
  PO: 774, // Pomona College
  SC: 889, // Scripps College
};

/** "Julie A. Medero" → "Julie Medero": single-letter middle initials and suffixes
 *  rarely appear on RMP and make the search miss. */
function cleanName(name: string): string {
  const cleaned = name
    .replace(/\b[A-Za-z]\.?(?=\s)/g, " ")
    .replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || name;
}

/**
 * RateMyProfessors search deep link; always safe to show, even with no data.
 *
 * With a campus code it opens the search already scoped to that college (the
 * school is preselected on RMP, the professor's name is filled in and can be
 * edited). A professor's RMP page can sit under any of the 5Cs regardless of the
 * campus the registrar lists, so the professor page also offers the other four
 * (see rmpCollegeLinks). With no campus it searches every school by name.
 */
export function rmpSearchUrl(name: string, school?: string): string {
  const q = encodeURIComponent(cleanName(name));
  const id = school ? RMP_SCHOOL_ID[school] : undefined;
  return id
    ? `https://www.ratemyprofessors.com/search/professors/${id}?q=${q}`
    : `https://www.ratemyprofessors.com/search/professors?query=${q}`;
}

/** The same name search at each of the 5Cs, home campus first. */
export function rmpCollegeLinks(name: string, home?: string | null): { code: string; url: string }[] {
  return Object.keys(RMP_SCHOOL_ID)
    .sort((a, b) => (a === home ? -1 : b === home ? 1 : 0))
    .map((code) => ({ code, url: rmpSearchUrl(name, code) }));
}

export type ManualRmpRow = {
  name: string;
  quality?: number;
  difficulty?: number;
  numRatings?: number;
  url?: string;
  tags?: string[];
};

/**
 * Curated import — no scraping. Drop a file at data/rmp-manual.json:
 *   [{ "name": "Julie Medero", "quality": 4.3, "difficulty": 3.1,
 *      "numRatings": 210, "url": "https://www.ratemyprofessors.com/professor/123" }]
 */
export async function importManualRmp(
  file = path.join(process.cwd(), "data", "rmp-manual.json"),
): Promise<{ matched: number; missing: string[] }> {
  if (!fs.existsSync(file)) return { matched: 0, missing: [] };
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as ManualRmpRow[];
  const missing: string[] = [];
  let matched = 0;
  for (const r of rows) {
    const norm = normalizeName(r.name);
    const found = await get<{ id: string }>("SELECT id FROM instructors WHERE normalized = ?", [norm]);
    if (!found) {
      missing.push(r.name);
      continue;
    }
    await run(
      `UPDATE instructors SET
         rmp_quality = ?, rmp_difficulty = ?, rmp_num_ratings = ?,
         rmp_url = ?, rmp_tags = ?, rmp_synced_at = ?
       WHERE id = ?`,
      [
        r.quality ?? null,
        r.difficulty ?? null,
        r.numRatings ?? null,
        r.url ?? null,
        (r.tags ?? []).join(","),
        new Date().toISOString(),
        found.id,
      ],
    );
    matched++;
  }
  return { matched, missing };
}
