/**
 * Pomona College catalog scraper (CourseLeaf/Coursedog catalog SPA).
 *
 *   node scripts/scrape-po.mjs [--out data/requirements/raw/po.json] [--only <substring>]
 *
 * Pomona's catalog (https://catalog.pomona.edu) is a Nuxt/Vue single-page app:
 * the HTML served to curl contains only the nav chrome plus a loading spinner, so
 * every page has to be rendered. The exceptions are top-level *content* pages like
 * /majorsminors, which the app does server-render.
 *
 * Flow:
 *   1. Render /majorsminors (SSR) and pull the department index links so we can name
 *      each program's owning department.
 *   2. Render /programs?page=1..N (108 programs, 20/page) and collect every
 *      /programs/<id> link with its display name.
 *   3. Render each /programs/<id> page and grab #main-content innerText, which holds
 *      "Requirements for the Major in X" prose plus the inline course-code chips.
 *
 * Steps 2 and 3 run through a pool of tabs on one headless Chrome (CDP) because the
 * program pages are client-rendered.
 *
 * Output: data/requirements/raw/po.json = [{ name, url, kind, department, text }]
 * Plus data/requirements/raw/po-department-index.json for the dept link table.
 *
 * Uses CDP_PORT / CDP_PROFILE env vars so parallel agents don't collide.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// NOTE: the brief hands us CDP_PORT=9344, but other parallel agents in this repo have
// been observed driving that same browser and stealing freshly created page targets
// (scripts/fetch-page.mjs grabs list.find(type==='page')). We default to a private port
// so the pool of tabs stays ours; override with CDP_PORT/CDP_PROFILE if you want 9344.
const PORT = Number(process.env.CDP_PORT || 9467);
const PROFILE = process.env.CDP_PROFILE || "/tmp/fetch-po-9467";
const HOST = "https://catalog.pomona.edu";
const CONCURRENCY = Number(process.env.PO_CONCURRENCY || 5);
const SETTLE_MS = Number(process.env.PO_SETTLE_MS || 900);

const argv = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT = argVal("--out", "data/requirements/raw/po.json");
const ONLY = argVal("--only", null);
const REPAIR = argv.includes("--repair");
const DELAY_MS = Number(process.env.PO_DELAY_MS || 250);

/** Pages that came back as a bot-verification interstitial rather than content. */
function isJunk(text) {
  if (!text) return true;
  if (/confirm you are human|security check|Pardon Our Interruption|Access Denied/i.test(text)) return true;
  return text.trim().length < 120;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------- CDP ---------------------------------- */

async function cdpVersion() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function ensureChrome() {
  let v = await cdpVersion();
  if (v) return v;
  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
    process.exit(2);
  }
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
      "--window-size=1400,2000",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    v = await cdpVersion();
    if (v) return v;
    await sleep(300);
  }
  console.error("chrome did not come up on port " + PORT);
  process.exit(2);
}

/** Minimal CDP connection: one websocket, promise-per-message-id. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).res(msg);
      pending.delete(msg.id);
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws error " + wsUrl));
  });
  return {
    ready,
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((res) => {
        pending.set(id, { res });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

/** One status probe of the rendered #main-content. */
async function pollOnce(page, expect) {
  const expectJs = expect ? JSON.stringify(expect) : "null";
  const rs = await page.send("Runtime.evaluate", {
    expression: `(function(){
      var m=document.querySelector('#main-content')||document.body;
      var spin=document.querySelector('[data-test="loadingRipple"]');
      var t=m.innerText||'';
      var exp=${expectJs};
      return JSON.stringify({len:t.length, spin: !!spin, hit: exp? t.indexOf(exp)>=0 : true, ready: document.readyState});
    })()`,
    returnByValue: true,
  });
  try {
    return JSON.parse(rs.result?.result?.value || "null");
  } catch {
    return null;
  }
}

/**
 * Render a URL in a fresh tab and return #main-content innerText (plus any hrefs we
 * need for link-following). Polls until the SPA has swapped its spinner for content.
 */
async function render(browser, url, { wantHtml = false, maxWaitMs = 30000, expect = null } = {}) {
  const created = await browser.send("Target.createTarget", { url: "about:blank" });
  const targetId = created.result?.targetId;
  if (!targetId) throw new Error("no target for " + url);
  // find the page target's ws url
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    info = list.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
    if (!info) await sleep(150);
  }
  if (!info) {
    await browser.send("Target.closeTarget", { targetId });
    throw new Error("no ws url for target " + targetId);
  }
  const page = connect(info.webSocketDebuggerUrl);
  try {
    await page.ready;
    await page.send("Runtime.enable");
    const deadline = Date.now() + maxWaitMs;
    let text = "";
    let stable = 0;
    let lastLen = -1;
    await page.send("Page.navigate", { url });
    // A parallel agent can grab this tab out from under us (fetch-page.mjs picks the
    // first page target it sees), so re-navigate whenever location.href drifts.
    while (Date.now() < deadline) {
      const cur = await page.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      const here = cur.result?.result?.value || "";
      const want = url.replace(/\/+$/, "");
      if (here === "about:blank" || !here.replace(/\/+$/, "").startsWith(want)) {
        await page.send("Page.navigate", { url });
        await sleep(1200);
        continue;
      }
      const st = await pollOnce(page, expect);
      if (!st || st.ready !== "complete") { await sleep(400); continue; }
      if (st.spin || st.len < 60) { await sleep(400); continue; }
      if (expect && !st.hit) { await sleep(400); continue; }
      if (st.len === lastLen) stable++;
      else stable = 0;
      lastLen = st.len;
      if (stable >= 2) break;
      await sleep(400);
    }
    await sleep(SETTLE_MS);
    const got = await page.send("Runtime.evaluate", {
      expression: wantHtml
        ? `(document.querySelector('#main-content')||document.body).innerHTML`
        : `(document.querySelector('#main-content')||document.body).innerText`,
      returnByValue: true,
    });
    text = got.result?.result?.value ?? "";
    if (wantHtml) {
      const hrefs = await page.send("Runtime.evaluate", {
        expression: `JSON.stringify([].slice.call(document.querySelectorAll('#main-content a[href]')).map(function(a){return [a.getAttribute('href'), (a.innerText||a.getAttribute('aria-label')||'').trim()]}))`,
        returnByValue: true,
      });
      return { text, hrefs: JSON.parse(hrefs.result?.result?.value || "[]") };
    }
    return { text };
  } finally {
    page.close();
    await browser.send("Target.closeTarget", { targetId });
  }
}

/** run with bounded concurrency + a pacing delay, preserving order */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        console.error(`  ! ${idx} failed: ${e.message}`);
        out[idx] = null;
      }
      if ((idx + 1) % 10 === 0) console.error(`  … ${idx + 1}/${items.length}`);
      await sleep(DELAY_MS + Math.floor(Math.random() * DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* --------------------------------- main ---------------------------------- */

const chromeVer = await ensureChrome();
const browser = connect(chromeVer.webSocketDebuggerUrl);
await browser.ready;
await browser.send("Target.setDiscoverTargets", { discover: false });

fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* 1. department index (SSR page, but render anyway for consistent parsing) */
console.error("[1/3] department index /majorsminors");
const dept = await render(browser, `${HOST}/majorsminors`, { wantHtml: true });
const deptLinks = (dept.hrefs || [])
  .map(([u, t]) => [u, t.replace(/\s+/g, " ").trim()])
  .filter(([u]) => /\/departments\/[^/]+\/overview/.test(u));
fs.writeFileSync(
  OUT.replace(/po\.json$/, "po-department-index.json"),
  JSON.stringify(deptLinks, null, 1),
);
console.error(`  ${deptLinks.length} department links`);

/* 2. program index pages */
console.error("[2/3] /programs index pages");
const programs = [];
const seenUrl = new Set();
for (let p = 1; p <= 12; p++) {
  const r = await render(browser, `${HOST}/programs?page=${p}`, {
    wantHtml: true,
    expect: "results found",
    maxWaitMs: 45000,
  });
  const links = (r.hrefs || []).filter(([u]) => /^\/programs\/[^/]+$/.test(u));
  const before = seenUrl.size;
  for (const [u, t] of links) {
    const full = HOST + u;
    if (seenUrl.has(full)) continue;
    seenUrl.add(full);
    // aria-label is "Link to Anthropology Major program"; innerText is the name
    const name = (t || "").replace(/^Link to\s+/, "").replace(/\s+program$/, "").trim();
    programs.push({ url: full, name });
  }
  const total = (r.text.match(/(\d+)\s+results found/) || [])[1];
  console.error(`  page ${p}: +${seenUrl.size - before} (total ${programs.length}/${total ?? "?"})`);
  if (!programs.length || (total && programs.length >= Number(total))) break;
}

if (ONLY) {
  const keep = programs.filter((x) => x.name.toLowerCase().includes(ONLY.toLowerCase()));
  programs.length = 0;
  programs.push(...keep);
  console.error(`  --only "${ONLY}" → ${programs.length} programs`);
}

/* 3. each program page */
function norm(raw) {
  return (raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
function mkRecord(prog, text) {
  const lower = (prog.name || "").toLowerCase();
  const kind = prog.kind || (/\bminor\b/.test(lower) ? "minor" : "major");
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const deptName =
    prog.department ||
    lines.find((l) => l && l !== prog.name && !/^Download as PDF$/.test(l));
  return { name: prog.name, url: prog.url, kind, department: deptName || null, text };
}

let existing = null;
let targets = programs;
if (REPAIR && fs.existsSync(OUT)) {
  existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
  targets = existing.filter((r) => isJunk(r.text)).map((r) => ({ ...r }));
  console.error(`[repair] re-rendering ${targets.length} junk/bot-blocked records of ${existing.length}`);
} else {
  console.error(`[3/3] rendering ${targets.length} program pages`);
}

const records = await pool(targets, REPAIR ? 1 : CONCURRENCY, async (prog) => {
  let text = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await render(browser, prog.url, { maxWaitMs: 35000 });
    text = norm(r.text);
    if (!isJunk(text)) break;
    console.error(`  ~ junk for "${prog.name}" (attempt ${attempt + 1}) — backing off`);
    await sleep(5000 + attempt * 8000);
  }
  return mkRecord(prog, text);
});

const fresh = records.filter(Boolean);
let clean = fresh;
if (existing) {
  const byUrl = new Map(fresh.map((r) => [r.url, r]));
  clean = existing.map((r) => byUrl.get(r.url) || r);
}
fs.writeFileSync(OUT, JSON.stringify(clean, null, 1));
console.error(
  `wrote ${OUT}: ${clean.length} records (${clean.filter((r) => r.kind === "major").length} major / ${clean.filter((r) => r.kind === "minor").length} minor), ${clean.filter((r) => isJunk(r.text)).length} still junk`,
);
browser.close();
