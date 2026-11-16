/**
 * Headless-Chrome screenshot driver over CDP (no puppeteer needed — Node 26 has
 * a global WebSocket and we already have Chrome installed).
 *
 *   node scripts/shoot.mjs            # writes shots/*.png
 *
 * Authenticated pages are captured by injecting the same session cookie
 * scripts/mint-session.mjs produces.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222;
const BASE = "http://localhost:3000";
const OUT = "shots";
const UA_PROFILE = "/tmp/5cycle-chrome-profile";

fs.mkdirSync(OUT, { recursive: true });

const cookie = execSync("node scripts/mint-session.mjs", { encoding: "utf8" })
  .trim()
  .split("=");

const SHOTS = [
  { route: "/", name: "01-landing", auth: false, full: 1800 },
  { route: "/catalog?term=FA2026", name: "02-catalog", auth: false, full: 1400 },
  { route: "/section/POLI-124-SC-01-SP2027", name: "03-section-perm", auth: true, full: 2000 },
  { route: "/planner?term=SP2027", name: "04-planner", auth: true, full: 2200 },
  { route: "/requirements", name: "05-checklist", auth: true, full: 2200 },
  { route: "/professors?term=SP2027", name: "06-professors", auth: false, full: 1400 },
  { route: "/professors/ins-aaron-aruck-0ca4b6", name: "07-professor", auth: true, full: 2000 },
  { route: "/profile", name: "08-profile", auth: true, full: 2000 },
];

async function waitForChrome(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let alreadyRunning = await waitForChrome(1000);
if (!alreadyRunning) {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
  fs.rmSync(UA_PROFILE, { recursive: true, force: true });
  spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${UA_PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  ).unref();
  if (!(await waitForChrome())) throw new Error("chrome never came up");
}

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method) {
    events.push(m.method);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, (m) => res(m.result ?? m.error ?? {}));
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Network.enable");
await send("Runtime.enable");

const results = [];
for (const s of SHOTS) {
  await send("Network.deleteCookies", { name: "cycle_session", domain: "localhost" });
  if (s.auth) {
    await send("Network.setCookie", {
      name: cookie[0],
      value: cookie[1],
      domain: "localhost",
      path: "/",
    });
  }

  await send("Page.navigate", { url: BASE + s.route });
  // Wait until the event stream stops growing, then let React hydrate/fonts settle.
  let last = -1;
  for (let i = 0; i < 40 && events.length !== last; i++) {
    last = events.length;
    await sleep(250);
  }
  await sleep(900);

  const metricName = "document.documentElement.scrollHeight";
  const { result: h } = await send("Runtime.evaluate", { expression: metricName });
  const contentH = Math.min(Number(h?.value ?? 1200), s.full ?? 1600);

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: contentH,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(500);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  if (shot.data) {
    const file = path.join(OUT, `${s.name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    const authed = s.auth ? "authed" : "public";
    const truncated = (Number(h?.value ?? 0) > contentH) ? ` (page is ${h.value}px, showing ${contentH})` : "";
    results.push(`  ${s.name}.png  ${s.route}  [${authed}]${truncated}`);
  } else {
    results.push(`  FAILED ${s.route}: ${JSON.stringify(shot).slice(0, 120)}`);
  }
}

console.log(results.join("\n"));
ws.close();
