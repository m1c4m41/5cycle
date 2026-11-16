#!/usr/bin/env node
/**
 * Pitzer College catalog scraper (Modern Campus Catalog™, catoid=27 = 2023-24 edition).
 *
 * Flow:
 *   1. Render the "Majors and Minors" landing page with headless Chrome so the AWS WAF
 *      JS challenge is solved, then lift the resulting cookies out of the same Chrome
 *      instance. Every later request is a plain fetch() with those cookies, which is
 *      ~50x faster than rendering 100+ pages.
 *   2. From the landing page, collect every field group (`preview_entity.php`) and every
 *      interdisciplinary program (`preview_program.php`).
 *   3. Each entity page is a table of contents pointing at the real pages:
 *        "<Field> Major", "<Field> Combined Major", "<Field> Minor", "<Field> Courses".
 *      Follow the Major/Minor ones (and, for interdisciplinary programs, the page itself).
 *   4. Extract the rendered text of the catalog content cell and write
 *      data/requirements/raw/pz.json as [{ name, url, kind, entity, text }].
 *
 * Usage:
 *   CDP_PORT=9341 CDP_PROFILE=/tmp/fetch-pz node scripts/scrape-pz.mjs [--out <file>]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT || 9341);
const PROFILE = process.env.CDP_PROFILE || "/tmp/fetch-pz";
const BASE = "https://catalog.pitzer.edu";
const CATOID = new URLSearchParams(process.argv.slice(2).join("&")).get("catoid") || "27";
const argOutIdx = process.argv.indexOf("--out");
const OUT =
  argOutIdx > -1 && process.argv[argOutIdx + 1]
    ? process.argv[argOutIdx + 1]
    : "data/requirements/raw/pz.json";
const RAWDIR = "/tmp/pz-raw";
const INDEX_URL = `${BASE}/content.php?catoid=${CATOID}&navoid=1880`;

/* ---------------------------------------------------------------- chrome/CDP */
async function version() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.method) {
        (this.listeners.get(m.method) || []).forEach((f) => f(m.params));
      }
    };
  }
  static async connect() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === "page") ?? list[0];
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(m, f) {
    if (!this.listeners.has(m)) this.listeners.set(m, []);
    this.listeners.get(m).push(f);
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    return r.result?.result?.value;
  }
}

let chrome = null;
async function ensureChrome() {
  if (await version()) return;
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--lang=en-US",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await version()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("chrome did not start on port " + PORT);
}

async function render(url) {
  await ensureChrome();
  const cdp = await CDP.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  const loaded = new Promise((res) => {
    const t = setTimeout(res, 20000);
    cdp.on("Page.loadEventFired", () => {
      clearTimeout(t);
      res();
    });
  });
  await cdp.send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 4000)); // WAF interstitial settle
  const html = await cdp.eval("document.documentElement.outerHTML");
  const cookieRes = await cdp.send("Network.getCookies", { urls: [BASE] });
  const cookies = (cookieRes.result?.cookies || []).map(
    (c) => `${c.name}=${c.value}`,
  );
  cdp.ws.close();
  return { html: html || "", cookies: cookies.join("; ") };
}

/* ------------------------------------------------------------------- fetching */
let cookieHeader = "";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const cache = new Map();

async function get(url) {
  if (cache.has(url)) return cache.get(url);
  fs.mkdirSync(RAWDIR, { recursive: true });
  const key = url.replace(/[^a-z0-9]+/gi, "_").slice(-160) + ".html";
  const file = path.join(RAWDIR, key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      headers: { cookie: cookieHeader, "user-agent": UA, accept: "text/html" },
      redirect: "follow",
    });
    const body = await r.text();
    if (r.status === 200 && body.length > 2000 && !/x-amzn-waf-action/i.test("")) {
      fs.writeFileSync(file, body);
      cache.set(url, body);
      return body;
    }
    // WAF expired / challenge: re-render through Chrome to refresh cookies.
    console.error(`  retry ${attempt + 1} ${r.status} ${body.length} ${url}`);
    const fresh = await render(url);
    if (fresh.cookies) cookieHeader = fresh.cookies;
    await new Promise((r2) => setTimeout(r2, 400));
  }
  fs.writeFileSync(file, "");
  cache.set(url, "");
  return "";
}

/* ---------------------------------------------------------------- text extract */
function textOf(h) {
  let i = h.indexOf('<td class="block_content"');
  if (i < 0) i = h.search(/<div[^>]+class="program_description/);
  if (i < 0) i = h.indexOf("<body");
  let seg = h.slice(i);
  const j = seg.indexOf("block_footer_lb");
  if (j > 0) seg = seg.slice(0, j);
  seg = seg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-5]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  seg = seg
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&ndash;|&#8211;/g, "-")
    .replace(/&mdash;|&#8212;/g, "-")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
  return seg
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/* ---------------------------------------------------------------- link harvest */
function links(h, re, base = BASE) {
  const out = [];
  const seen = new Set();
  for (const m of h.matchAll(/href="([^"]+)"/g)) {
    let u = htmlUnescape(m[1]);
    if (!re.test(u)) continue;
    if (!/^https?:/i.test(u)) u = base + (u.startsWith("/") ? "" : "/") + u;
    if (u.includes("&print") || u.includes("#")) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}
function htmlUnescape(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}
function anchorTexts(h) {
  const map = new Map();
  for (const m of h.matchAll(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const u = htmlUnescape(m[1]).replace(/^\/+/, "");
    const t = htmlUnescape(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!map.has(u) && t) map.set(u, t);
  }
  return map;
}
const full = (p) => `${BASE}/${p}`;

/* ----------------------------------------------------------------------- main */
console.error("rendering index page to clear the WAF challenge …");
const seed = await render(INDEX_URL);
cookieHeader = seed.cookies;
fs.mkdirSync(RAWDIR, { recursive: true });
fs.writeFileSync(path.join(RAWDIR, "index.html"), seed.html);

const indexLinks = links(seed.html, /preview_(entity|program)\.php/);
const texts = anchorTexts(seed.html);
console.error(`index: ${indexLinks.length} field groups / programs`);

const records = [];
const donePrograms = new Set();

async function scrapeProgram(url, fallbackName, entityName) {
  if (donePrograms.has(url)) return;
  donePrograms.add(url);
  const h = await get(url);
  if (!h) {
    console.error("  !! empty: " + url);
    records.push({ name: fallbackName, url, kind: "unknown", entity: entityName, text: "" });
    return;
  }
  const t = /<title>([^<]*)<\/title>/.exec(h)?.[1] || "";
  const name =
    t
      .replace(/\s*-\s*Pitzer College\s*$/i, "")
      .replace(/^\s*Program:\s*/i, "")
      .trim() || fallbackName;
  const kind = /minor/i.test(name) ? "minor" : /major/i.test(name) ? "major" : "other";
  records.push({ name, url, kind, entity: entityName || name, text: textOf(h) });
  console.error(`  ok [${kind}] ${name}`);
}

for (const url of indexLinks) {
  const label = (texts.get(url.replace(BASE + "/", "")) || "").trim();
  if (/preview_entity/.test(url)) {
    const h = await get(url);
    if (!h) {
      console.error("  !! empty entity " + url);
      continue;
    }
    const entName = label || (/<title>([^<]*)<\/title>/.exec(h)?.[1] || "").replace(/\s*-\s*Pitzer College\s*$/i, "").trim();
    const sub = anchorTexts(h);
    const progs = links(h, /preview_program\.php/);
    console.error(`field group: ${entName} (${progs.length} program pages)`);
    for (const p of progs) {
      const pl = (sub.get(p.replace(BASE + "/", "")) || "").trim();
      if (!pl) continue;
      if (/courses$/i.test(pl)) continue; // course inventory, not a requirement page
      await scrapeProgram(p, pl, entName);
    }
  } else {
    // interdisciplinary program page: may itself hold the requirements or list sub-pages
    const h = await get(url);
    if (!h) continue;
    const progs = links(h, /preview_program\.php/);
    const self = textOf(h);
    const hasReq = /Requirements for (the )?(Major|Minor)/i.test(self);
    const sub = anchorTexts(h);
    const children = progs.filter((p) => {
      const t = (sub.get(p.replace(BASE + "/", "")) || "").trim();
      return t && !/courses$/i.test(t) && p !== url;
    });
    const groupLabel =
      label ||
      (/<title>([^<]*)<\/title>/.exec(h)?.[1] || "")
        .replace(/\s*-\s*Pitzer College\s*$/i, "")
        .trim();
    if (children.length && !hasReq) {
      console.error(`program group: ${groupLabel} (${children.length} sub-pages)`);
      for (const p of children) await scrapeProgram(p, groupLabel);
    } else {
      await scrapeProgram(url, groupLabel);
    }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(records, null, 1));
console.error(`\nwrote ${records.length} records -> ${OUT}`);
const byKind = {};
for (const r of records) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
console.error(JSON.stringify(byKind));
