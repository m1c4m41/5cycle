#!/usr/bin/env node
/**
 * Scrape Scripps College's Modern Campus Catalog(TM) program pages.
 *
 *   node scripts/scrape-scr.mjs          # ~6 min cold, seconds warm (cached DOM)
 *
 * Pipeline
 *   A. render the "Majors and Minors" listing
 *      (content.php?catoid=35&navoid=4466&print) and collect preview_entity/preview_program links
 *   B. render each entity page and collect the links under its "Programs" heading —
 *      those preview_program.php?poid=N pages hold the actual "Requirements for the
 *      Major / Minor" bullets
 *   C. render each program page with `&print`, cut the catalog body out of the DOM,
 *      classify major vs minor, and write data/requirements/raw/scr.json as
 *      [{ name, url, kind, text }]  (course-catalog pages go to scr-courses.json)
 *
 * catalog.scrippscollege.edu is behind an AWS WAF JavaScript challenge (plain curl gets
 * HTTP 202 with an empty body), so every request goes through scripts/fetch-page.mjs /
 * headless Chrome. Four Chrome instances run in parallel (ports 9343-9346, profiles
 * /tmp/fetch-scr*); each worker owns one port so two fetches never drive the same tab.
 *
 * Rendered HTML is cached under /tmp/scr/pages, so re-runs only fetch what is missing.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://catalog.scrippscollege.edu";
const CATOID = process.env.CATOID || "35"; // 2025-2026 catalog edition
const LISTING = `content.php?catoid=${CATOID}&navoid=4466`;
const CACHE = process.env.SCR_CACHE || "/tmp/scr/pages";
const OUT = process.env.SCR_OUT || "data/requirements/raw/scr.json";
const WORKERS = Number(process.env.SCR_WORKERS || 4);

fs.mkdirSync(CACHE, { recursive: true });

/* ------------------------------- text utils ------------------------------ */
const unesc = (s) =>
  s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;|&minus;/g, "-")
    .replace(/&hellip;/g, "...")
    .replace(/&bull;/g, "-")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");

/** The catalog body is the region between <h1 id="acalog-content"> and the page footer. */
function bodySlice(html) {
  const m = html.match(/<h1[^>]*id="acalog-content"/i);
  if (!m) return "";
  let b = html.slice(m.index);
  const e = b.slice(40).match(/All catalogs|acalog-client-footer|Powered by Modern Campus/i);
  if (e) b = b.slice(0, e.index + 40);
  return b.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
}

function contentText(html) {
  let b = bodySlice(html);
  if (!b) return "";
  b = b
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|ul|ol|dl|dt|dd|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n - ")
    .replace(/<[^>]+>/g, " ");
  b = unesc(b).replace(/\u00a0/g, " ");
  return b
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(
      (l) =>
        l &&
        l !== "-" &&
        !/^Close$/.test(l) &&
        !/this Page \(opens a new window\)$/.test(l) &&
        !/^Print this Page$/.test(l),
    )
    .join("\n");
}

function pageTitle(html, fallback = "") {
  const m = html.match(/<h1[^>]*id="acalog-content"[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? unesc(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : fallback;
}

/* ------------------- worker-owned serial fetch queue --------------------- */
// Each worker = one headless Chrome on its own port. fetch-page.mjs drives the first
// page target it finds, so only one of them may run per port at a time.
function runFetch(url, file, w) {
  return new Promise((res, rej) => {
    const p = spawn("node", ["scripts/fetch-page.mjs", url, file], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, CDP_PORT: String(w.port), CDP_PROFILE: w.profile },
    });
    p.on("exit", (code) =>
      fs.existsSync(file) && fs.statSync(file).size > 20000
        ? res(file)
        : rej(new Error(`exit ${code}, ${fs.existsSync(file) ? fs.statSync(file).size : 0}b, ${url}`)),
    );
    p.on("error", rej);
  });
}

const queues = Array.from({ length: WORKERS }, () => []);
const busy = Array.from({ length: WORKERS }, () => false);
let qIdx = 0;

async function drain(w) {
  if (busy[w]) return; // one in-flight fetch per Chrome instance
  busy[w] = true;
  const worker = { port: 9343 + w, profile: w === 0 ? "/tmp/fetch-scr" : `/tmp/fetch-scr-w${w + 1}` };
  while (queues[w].length) {
    const job = queues[w].shift();
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runFetch(job.url, job.file, worker);
        job.html = fs.readFileSync(job.file, "utf8");
        console.error(`fetched ${job.label}`);
        last = null;
        break;
      } catch (e) {
        last = e; // headless Chrome intermittently aborts (exit 13) on this box
        fs.rmSync(job.file, { force: true });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    job.done(last);
  }
  busy[w] = false;
}

function enqueue(job) {
  const w = qIdx++ % WORKERS;
  queues[w].push(job);
  drain(w);
}

function getPage(relUrl, label) {
  const url = BASE + "/" + relUrl.replace(/^\//, "") + (relUrl.includes("?") ? "&" : "?") + "print";
  const tag = relUrl.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(-70) || "page";
  const file = path.join(CACHE, tag + ".html");
  // The share-widget links baked into every Modern Campus page carry the page's own
  // encoded id, so they double as an integrity check: a cached file whose body is about a
  // different poid (a Chrome instance that answered the wrong fetch) gets discarded.
  const id = (relUrl.match(/(?:poid|ent_oid)=(\d+)/) || [])[1];
  const param = /ent_oid=/.test(relUrl) ? "ent_oid" : "poid";
  const matches = (h) =>
    !id || h.includes(`${param}%3D${id}`) || h.includes(`${param}=${id}`) || h.includes(`${param}%3d${id}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 20000) {
    const html = fs.readFileSync(file, "utf8");
    if (matches(html)) return Promise.resolve({ url, html });
    console.error(`re-fetching stale/mismatched cache ${tag}`);
    fs.rmSync(file, { force: true });
  }
  return new Promise((res) =>
    enqueue({
      url,
      file,
      label,
      done: (err) => {
        if (!err) {
          const html = fs.readFileSync(file, "utf8");
          if (!matches(html)) {
            fs.rmSync(file, { force: true });
            err = new Error(`mismatched page body for ${url}`);
          } else return res({ url, html });
        }
        res({ url, html: "", err });
      },
    }),
  );
}

/* --------------------------------- crawl --------------------------------- */
// Normalize a program/entity URL to a de-duplicated key (drops returnto/print noise and
// any link that points into an archived catalog edition).
function normHref(raw) {
  const href = unesc(raw).replace(BASE, "").replace(/^\/+/, "");
  const m = href.match(/^(preview_entity|preview_program)\.php\?([^#]*)/);
  if (!m) return null;
  const q = {};
  for (const kv of m[2].split("&")) {
    const [k, v] = kv.split("=");
    if (/^(catoid|ent_oid|poid)$/.test(k) && /^\d+$/.test(v || "")) q[k] = v;
  }
  if (q.catoid !== CATOID) return null;
  if (m[1] === "preview_entity" && q.ent_oid) return `preview_entity.php?catoid=${q.catoid}&ent_oid=${q.ent_oid}`;
  if (m[1] === "preview_program" && q.poid) return `preview_program.php?catoid=${q.catoid}&poid=${q.poid}`;
  return null;
}

const progLinks = new Map(); // normalized relUrl -> label
function collect(html) {
  const re = /<a[^>]*href="([^"]*(?:preview_entity|preview_program)\.php[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const found = [];
  let m;
  while ((m = re.exec(html))) {
    const href = normHref(m[1]);
    if (!href) continue;
    const label = unesc(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!label || /this Page/.test(label)) continue;
    if (!found.some((f) => f.href === href)) found.push({ href, label });
    if (!progLinks.has(href)) progLinks.set(href, label);
  }
  return found;
}

const list = await getPage(LISTING, "listing (majors & minors)");
const first = collect(list.html);
console.error(`stage A: ${first.length} entity/program links`);

const entities = first.filter((l) => l.href.startsWith("preview_entity"));
await Promise.all(entities.map((e) => getPage(e.href, e.label).then(({ html }) => collect(html))));
console.error(`stage B: +${progLinks.size - first.length} links from ${entities.length} entity pages`);

// C (+ follow-on rounds): program pages can themselves link to other program pages,
// e.g. "Science (all)" -> the individual science majors, so keep going until closure.
let pending = [...progLinks.entries()].filter(([href]) => href.startsWith("preview_program"));
const seen = new Set(pending.map(([h]) => h));
const fetchedNames = new Map();
const failed = [];
let round = 0;
while (pending.length && round++ < 4) {
  console.error(`stage C${round}: ${pending.length} program pages`);
  const results = await Promise.all(
    pending.map(([href, label]) =>
      getPage(href, label).then(async ({ url, html, err }) => {
        if (!html) {
          failed.push(`${label} ${url} ${err?.message}`);
          return null;
        }
        const name = pageTitle(html, label);
        const text = contentText(html);
        if (!text || text.length < 60) {
          failed.push(`${label} ${url} (empty body)`);
          return null;
        }
        const kind = /^courses in /i.test(name) ? "courses" : /minor/i.test(name) ? "minor" : "major";
        const before = progLinks.size;
        collect(html);
        return { rec: { name, url, kind, text }, grew: progLinks.size > before };
      }),
    ),
  );
  for (const r of results) if (r) fetchedNames.set(r.rec.name.toLowerCase() + "|" + r.rec.kind, r.rec);
  pending = [...progLinks.entries()].filter(([href]) => href.startsWith("preview_program") && !seen.has(href));
  for (const [h] of pending) seen.add(h);
}
for (const f of failed) console.error(`MISSING: ${f}`);

// Some poids are reachable from more than one entity page (Music, the dual majors, STS),
// so collapse duplicates and keep the richest text.
const recs = [...fetchedNames.values()];
const byKey = new Map();
for (const r of recs) {
  const k = r.kind + " " + r.name.toLowerCase();
  if (!byKey.has(k) || byKey.get(k).text.length < r.text.length) byKey.set(k, r);
}
const all = [...byKey.values()];
const keep = all.filter((r) => r.kind !== "courses").sort((a, b) => a.name.localeCompare(b.name));
const courses = all.filter((r) => r.kind === "courses");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(keep, null, 2));
fs.writeFileSync(OUT.replace(/\.json$/, "-courses.json"), JSON.stringify(courses, null, 2));
console.error(
  `wrote ${keep.length} requirement records (${keep.filter((r) => r.kind === "major").length} major / ` +
    `${keep.filter((r) => r.kind === "minor").length} minor) -> ${OUT}`,
);
console.error(`wrote ${courses.length} course-listing records -> ${OUT.replace(/\.json$/, "-courses.json")}`);
for (const r of keep) console.error(`  [${r.kind}] ${r.name} (${r.text.length})`);
