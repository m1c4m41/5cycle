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

/**
 * Best-effort search deep link; always safe to show, even with no data.
 *
 * Searches by NAME ONLY, across every school on RateMyProfessors. A professor's
 * RMP page can sit under any of the five colleges (or more than one) regardless of
 * which campus the registrar lists, so narrowing by home campus — or adding a
 * campus code to the query text — hid pages that exist. The results list shows
 * which school each match belongs to. (The `school` argument is kept for callers
 * but intentionally unused.)
 */
export function rmpSearchUrl(name: string, _school?: string): string {
  // "Julie A. Medero" → "Julie Medero": single-letter middle initials and
  // suffixes rarely appear on RMP and make the search miss.
  const cleaned = name
    .replace(/\b[A-Za-z]\.?(?=\s)/g, " ")
    .replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return `https://www.ratemyprofessors.com/search/professors?query=${encodeURIComponent(cleaned || name)}`;
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
