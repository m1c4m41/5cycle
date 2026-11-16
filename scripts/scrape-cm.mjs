/**
 * Scraper for the Claremont McKenna College catalog (Modern Campus Catalog™,
 * catalog.claremontmckenna.edu).
 *
 * The site sits behind an AWS WAF JavaScript challenge (plain curl gets a 202 with an
 * empty body), so every request goes through scripts/fetch-page.mjs, which renders the
 * page in headless Chrome over CDP. Keep the port/profile unique so parallel school
 * scrapers don't fight over one Chrome instance:
 *
 *   CDP_PORT=9342 CDP_PROFILE=/tmp/fetch-cm node scripts/scrape-cm.mjs discover
 *   CDP_PORT=9342 CDP_PROFILE=/tmp/fetch-cm node scripts/scrape-cm.mjs pages
 *   CDP_PORT=9342 CDP_PROFILE=/tmp/fetch-cm node scripts/scrape-cm.mjs dump
 *
 * Stages
 *   discover  fetch the "Majors & Sequences" listing and every preview_entity page,
 *             cache the rendered text, and record the preview_program (poid) links each
 *             entity points at                              -> $SCRATCH/index.json
 *   pages     fetch every poid page recorded by discover   -> $SCRATCH/pages/<poid>.txt
 *   dump      assemble data/requirements/raw/cm.json for human audit
 *
 * Scratch (rendered HTML + extracted text) lives in /tmp, never in the repo; the only
 * file this writes inside the project is data/requirements/raw/cm.json.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE = "https://catalog.claremontmckenna.edu";
const CATOID = Number(process.env.CATOID || 43); // 43 = 2026-2027 Catalog
const LISTING_NAVOID = Number(process.env.NAVOID || 9175); // "Majors & Sequences"
const SCRATCH = process.env.SCRATCH || "/tmp/fetch-cm-html";
const RAW_OUT = process.env.RAW_OUT || "data/requirements/raw/cm.json";
const PORT = process.env.CDP_PORT || "9342";
const PROFILE = process.env.CDP_PROFILE || "/tmp/fetch-cm";

fs.mkdirSync(path.join(SCRATCH, "html"), { recursive: true });
fs.mkdirSync(path.join(SCRATCH, "pages"), { recursive: true });

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Render a URL through headless Chrome and return its HTML. Cached on disk. */
function fetchHtml(url, cacheName) {
  const file = path.join(SCRATCH, "html", cacheName + ".html");
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").length > 5000 && !process.env.FORCE_FETCH) {
    return fs.readFileSync(file, "utf8");
  }
  const out = execFileSync(
    "node",
    ["scripts/fetch-page.mjs", url, file],
    {
      env: { ...process.env, CDP_PORT: PORT, CDP_PROFILE: PROFILE },
      stdio: ["ignore", "inherit", "inherit"],
      maxBuffer: 1 << 28,
    },
  );
  void out;
  if (!fs.existsSync(file)) throw new Error("fetch failed: " + url);
  return fs.readFileSync(file, "utf8");
}

/** Strip the catalog chrome: keep only the acalog content heading … nav block. */
function contentHtml(h) {
  let i = h.indexOf('<h1 id="acalog-content">');
  if (i < 0) i = h.indexOf('<h1 id="acalog-page-title">');
  if (i < 0) {
    const m = /<h1[^>]*>/.exec(h);
    i = m ? m.index : -1;
  }
  if (i < 0) return "";
  let end = h.indexOf("Catalog Navigation", i);
  if (end < 0) end = h.indexOf("All catalogs", i);
  if (end < 0) end = i + 60000;
  return h.slice(i, end);
}

function toText(h) {
  let t = h
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|dt|dd|td|th)>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "-");
  t = t.replace(/[ \t]+/g, " ").replace(/\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n");
  return t.trim();
}

/** All preview_program links (poid + label) inside a fragment. */
function programLinks(h) {
  const out = [];
  const re = /<a[^>]+href="([^"]*preview_program\.php[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(h))) {
    const poid = /(poid=)(\d+)/i.exec(m[1]);
    const label = toText(m[2].replace(/<[^>]+>/g, " ")).trim();
    if (poid && label) out.push({ poid: poid[2], label, url: BASE + "/preview_program.php?catoid=" + CATOID + "&poid=" + poid[2] + "&print" });
  }
  const seen = new Set();
  return out.filter((x) => !seen.has(x.poid) && seen.add(x.poid));
}

/** Parse the Majors & Sequences index into {name, ent_oid, kind}. */
function parseListing(h) {
  const body = contentHtml(h);
  const seqAt = body.search(/<h2[^>]*>\s*Sequences/i);
  const chunks = [
    { kind: "major", html: seqAt > 0 ? body.slice(0, seqAt) : body },
    { kind: "sequence", html: seqAt > 0 ? body.slice(seqAt) : "" },
  ];
  const rows = [];
  for (const c of chunks) {
    const re = /<a[^>]+href="([^"]*preview_entity\.php[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(c.html))) {
      const oid = /ent_oid=(\d+)/i.exec(m[1]);
      const name = toText(m[2].replace(/<[^>]+>/g, " ")).replace(/"/g, " ").trim();
      if (oid && name) rows.push({ name, ent_oid: oid[1], kind: c.kind, url: BASE + "/preview_entity.php?catoid=" + CATOID + "&ent_oid=" + oid[1] + "&print" });
    }
  }
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.ent_oid) && seen.add(r.ent_oid));
}

function stageDiscover() {
  const listingUrl = `${BASE}/content.php?catoid=${CATOID}&navoid=${LISTING_NAVOID}`;
  const rows = parseListing(fetchHtml(listingUrl, "listing"));
  console.log(`listing: ${rows.length} programs (${rows.filter((r) => r.kind === "major").length} majors, ${rows.filter((r) => r.kind === "sequence").length} sequences)`);
  const index = [];
  for (const r of rows) {
    let htmlTxt = "";
    let links = [];
    try {
      htmlTxt = contentHtml(fetchHtml(r.url, "ent-" + r.ent_oid));
      links = programLinks(htmlTxt);
    } catch (e) {
      console.log("  !! " + r.name + ": " + e.message);
    }
    index.push({ ...r, text: toText(htmlTxt), links });
    console.log(`  ${r.kind.padEnd(8)} ${r.name} [ent ${r.ent_oid}] -> ${links.map((l) => l.label + "(" + l.poid + ")").join(" | ")}`);
  }
  fs.writeFileSync(path.join(SCRATCH, "index.json"), JSON.stringify(index, null, 1));
  console.log("wrote " + path.join(SCRATCH, "index.json"));
}

function stagePages() {
  const index = JSON.parse(fs.readFileSync(path.join(SCRATCH, "index.json"), "utf8"));
  const want = new Map();
  for (const e of index) for (const l of e.links) if (!want.has(l.poid)) want.set(l.poid, l);
  console.log(`${want.size} unique program pages`);
  for (const [poid, l] of want) {
    const file = path.join(SCRATCH, "pages", poid + ".txt");
    if (fs.existsSync(file) && !process.env.FORCE_FETCH) continue;
    try {
      const txt = toText(contentHtml(fetchHtml(l.url, "poid-" + poid)));
      fs.writeFileSync(file, l.label + "\n" + l.url + "\n\n" + txt);
      console.log(`  ok ${poid} ${l.label} (${txt.length} chars)`);
    } catch (e) {
      console.log(`  !! ${poid} ${l.label}: ${e.message}`);
    }
  }
}

function stageDump() {
  const index = JSON.parse(fs.readFileSync(path.join(SCRATCH, "index.json"), "utf8"));
  const out = [];
  for (const e of index) {
    out.push({ name: e.name + " (" + (e.kind === "major" ? "entity page" : "sequence entity page") + ")", url: e.url, kind: e.kind === "major" ? "major" : "minor", text: e.text });
    for (const l of e.links) {
      const file = path.join(SCRATCH, "pages", l.poid + ".txt");
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8");
      const text = raw.split("\n\n").slice(1).join("\n\n");
      const kind = /course list|courses in/i.test(l.label)
        ? "courses"
        : /minor|sequence/i.test(l.label)
          ? "minor"
          : e.kind === "major"
            ? "major"
            : "minor";
      out.push({ name: e.name + " — " + l.label, url: l.url, kind, entity: e.ent_oid, poid: l.poid, text });
    }
  }
  fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, null, 1));
  console.log(`wrote ${RAW_OUT}: ${out.length} records, ${(fs.statSync(RAW_OUT).size / 1024).toFixed(0)}KB`);
}

const stage = process.argv[2] || "all";
if (stage === "discover" || stage === "all") stageDiscover();
if (stage === "pages" || stage === "all") stagePages();
if (stage === "dump" || stage === "all") stageDump();
