/**
 * Scrape Harvey Mudd College major/minor/emphasis requirements.
 *
 * HMC has two usable sources:
 *   • https://www.hmc.edu/academics/majors/  – plain-curl WordPress page that indexes the
 *     majors and links each department's "Major Requirements" page.
 *   • https://catalog.hmc.edu/               – the official Modern Campus Catalog™ bulletin
 *     (catoid=28 == 2026-2027 edition). Each Program has a `preview_program.php?poid=N` page
 *     with the exact requirement list and course codes. content.php / preview_program.php are
 *     behind the same AWS WAF JS challenge as the other 5C catalogs, so we render them through
 *     headless Chrome via scripts/fetch-page.mjs.
 *
 * Output: data/requirements/raw/hm.json
 *   [{ name, url, kind, text, courses: [{code,title}], headings: [...] }]
 *
 *   node scripts/scrape-hm.mjs                 # crawl every program below
 *   node scripts/scrape-hm.mjs --list          # re-discover program ids from the nav pages
 *   CDP_PORT=9381 CDP_PROFILE=/tmp/fetch-hm node scripts/scrape-hm.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CATOID = Number(process.env.HM_CATOID || 28); // 28 = 2026-2027 edition
const CDP_PORT = process.env.CDP_PORT || "9381";
const CDP_PROFILE = process.env.CDP_PROFILE || "/tmp/fetch-hm";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const OUT = path.join("data", "requirements", "raw", "hm.json");
const TMP = fs.mkdtempSync("/tmp/hm-scrape-");

/** Catalog nav sections worth enumerating when run with --list. */
const NAV_SECTIONS = [1432, 1436, 1437, 1438, 1439, 1440, 1441, 1442, 1443, 1462];

/**
 * Program pages, keyed by poid, discovered from the department nav pages listed above
 * (the `returnto=` link on each department page is the canonical one for that dept).
 * kind comes from the catalog's own "Programs / Major | Minor | Emphasis" grouping.
 */
const PROGRAMS = [
  { poid: 1021, name: "Biology, General Option", kind: "major" },
  { poid: 989, name: "Biology, Molecular Biology Option", kind: "major" },
  { poid: 991, name: "Chemistry Major", kind: "major" },
  { poid: 992, name: "Computer Science", kind: "major" },
  { poid: 1022, name: "Engineering", kind: "major" },
  { poid: 993, name: "Mathematics", kind: "major" },
  { poid: 994, name: "Physics, Standard Program", kind: "major" },
  { poid: 995, name: "Physics, Applied Physics Option", kind: "major" },
  { poid: 996, name: "Physics, Astrophysics Option", kind: "major" },
  { poid: 997, name: "Physics, Biophysics Option", kind: "major" },
  { poid: 998, name: "Physics, Chemical Physics Option", kind: "major" },
  { poid: 999, name: "Physics, Education Option", kind: "major" },
  { poid: 1000, name: "Physics, Geophysics Option", kind: "major" },
  { poid: 1001, name: "Physics, Mathematical Physics Option", kind: "major" },
  { poid: 1002, name: "Physics, Computational Physics Option", kind: "major" },
  { poid: 1038, name: "Joint Major in Biology and Climate", kind: "major" },
  { poid: 1018, name: "Joint Major in Chemistry and Biology", kind: "major" },
  { poid: 1033, name: "Joint Major in Chemistry and Climate", kind: "major" },
  { poid: 1031, name: "Joint Major in Computer Science and Climate", kind: "major" },
  { poid: 1016, name: "Joint Major in Computer Science and Mathematics", kind: "major" },
  { poid: 1027, name: "Joint Major in Computer Science and Physics", kind: "major" },
  { poid: 1052, name: "Joint Major in Mathematics and Climate", kind: "major" },
  { poid: 1024, name: "Joint Major in Mathematics and Physics", kind: "major" },
  { poid: 990, name: "Mathematical and Computational Biology", kind: "major" },
  { poid: 1005, name: "Biology Minor", kind: "minor" },
  { poid: 1006, name: "Chemistry Minor", kind: "minor" },
  { poid: 1020, name: "Computer Science Minor", kind: "minor" },
  { poid: 1007, name: "Engineering Minor", kind: "minor" },
  { poid: 1008, name: "Mathematics Minor", kind: "minor" },
  { poid: 1009, name: "Physics Minor", kind: "minor" },
  { poid: 1030, name: "Emphasis in Data Science", kind: "emphasis" },
  { poid: 1010, name: "Emphasis in Environmental Analysis", kind: "emphasis" },
  { poid: 1011, name: "3-2 Program in Economics and Engineering with CMC", kind: "other" },
  { poid: 1012, name: "3-2 Program in Engineering with Scripps College", kind: "other" },
  { poid: 1013, name: "Claremont Scholars Program", kind: "other" },
];

/* ------------------------------------------------------------------ fetch */

function curl(url, out) {
  const r = spawnSync("curl", ["-sL", "-A", UA, "-o", out, "-w", "%{http_code} %{size_download}", url], {
    encoding: "utf8",
  });
  const [code, size] = (r.stdout || "").trim().split(" ");
  return { code, size: Number(size || 0) };
}

function render(url, out) {
  const r = spawnSync("node", ["scripts/fetch-page.mjs", url, out], {
    encoding: "utf8",
    env: { ...process.env, CDP_PORT, CDP_PROFILE },
    maxBuffer: 64 << 20,
  });
  const ok = r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 2000;
  if (!ok) console.error(`  ! render failed: ${(r.stderr || "").split("\n").slice(-2).join(" ")}`);
  return ok;
}

/** Fetch a catalog page: try curl first (cheap), fall back to rendered Chrome (AWS WAF). */
function getPage(url, tag) {
  const out = path.join(TMP, tag.replace(/[^a-z0-9]/gi, "_") + ".html");
  const c = curl(url, out);
  const body = c.size > 1000 ? fs.readFileSync(out, "utf8") : "";
  const waf = c.code !== "200" || !body.includes("</html>") || body.length < 3000;
  if (!waf) return body;
  if (render(url, out)) return fs.readFileSync(out, "utf8");
  return "";
}

/* ------------------------------------------------------------------ parse */

const strip = (s) => s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, "\n").trim();

function textOf(html) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // Keep only the catalog content region when present.
  const m =
    t.match(/<div[^>]+id="aspnetForm"[\s\S]*/) ||
    t.match(/<div[^>]+class="[^"]*\bbody\b[^"]*"[\s\S]*/) ||
    [t];
  t = m[0];
  // Drop the standard catalog chrome (top nav / footer / share boxes).
  t = t.replace(/<div[^>]+id="(?:page_header|page_footer|nav_column|menu_column|breadcrumb|rightnav)[\s\S]*?(?=<div[^>]+id=")/gi, "");
  t = t
    .replace(/<br[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|span)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&#39;/g, "'");
  // Cut chrome strings that survive the above.
  t = t.replace(/^[\s\S]*?Print this Page/, "").replace(/Print this Page[\s\S]*$/g, "");
  return strip(t);
}

/** "MATH082 HM - Differential Equations" (catalog renders dept+num glued, then affiliation). */
const COURSE_RE = /\b([A-Z]{3,4})\s?0*(\d{1,3}[A-Z]?)\s+(HM)\s*[-–]\s*([^\n]{2,90})/g;
function extractCourses(text) {
  const seen = new Map();
  for (const m of text.matchAll(COURSE_RE)) {
    const code = `${m[1]} ${String(m[2]).padStart(3, "0")} HM`;
    if (!seen.has(code)) seen.set(code, strip(m[4]).slice(0, 80));
  }
  return [...seen].map(([code, title]) => ({ code, title }));
}

/* ------------------------------------------------------------------- main */

if (process.argv.includes("--list")) {
  for (const navoid of NAV_SECTIONS) {
    const url = `https://catalog.hmc.edu/content.php?catoid=${CATOID}&navoid=${navoid}&print`;
    const html = getPage(url, `nav-${navoid}`);
    if (!html) continue;
    const names = [...html.matchAll(/preview_program\.php\?catoid=\d+&poid=(\d+)[^"]*"[^>]*>([^<]+)</g)];
    console.log(`\n### navoid=${navoid}  ${url}`);
    for (const [, poid, name] of new Map(names.map((n) => [n[1], n])).values())
      console.log(`  { poid: ${poid}, name: "${strip(name)}", kind: "?" },`);
  }
  process.exit(0);
}

const results = [];
for (const p of PROGRAMS) {
  const url = `https://catalog.hmc.edu/preview_program.php?catoid=${CATOID}&poid=${p.poid}&print`;
  process.stderr.write(`[${results.length + 1}/${PROGRAMS.length}] ${p.name} (poid ${p.poid}) … `);
  let html = getPage(url, `poid-${p.poid}`);
  // WAF sometimes serves the challenge shell; give the renderer one more shot.
  if (!html || html.length < 3000) html = getPage(url, `poid-${p.poid}-retry`);
  const text = html ? textOf(html) : "";
  const courses = extractCourses(text);
  console.error(`${text.length} chars, ${courses.length} course codes`);
  results.push({
    name: p.name,
    url,
    kind: p.kind,
    poid: p.poid,
    text,
    courses,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`\nwrote ${OUT} (${results.length} programs, ${fs.statSync(OUT).size} bytes)`);
console.log(`temp DOM kept in ${TMP}`);
