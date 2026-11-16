/**
 * Rendered-HTML fetcher over headless Chrome + CDP.
 *
 * Several of the 5C catalog sites (catalog.pitzer.edu, catalog.claremontmckenna.edu,
 * catalog.scrippscollege.edu) sit behind an AWS WAF *JavaScript* challenge: a plain
 * HTTP request gets `HTTP 202` with an empty body and `x-amzn-waf-action: challenge`.
 * Chrome executes the interstitial, receives the `aws-waf-token` cookie, and the
 * retry succeeds — which is exactly what this script does for us.
 *
 *   node scripts/fetch-page.mjs <url> [outfile]
 *
 * Writes the rendered DOM to outfile (or stdout when omitted). Exit code 2 means
 * "Chrome could not render it", so callers can fall back to another source.
 *
 * Deliberately dependency-free (Node's global WebSocket + the Chrome we already
 * use for screenshots). Reuses one long-lived Chrome instance across calls via the
 * keepalive file, because spinning Chrome up per URL is slower than the fetch.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = process.env.CDP_PROFILE || "/tmp/5cycle-fetch-profile";
const WAIT_MS = Number(process.env.RENDER_WAIT_MS || 3500);

const url = process.argv[2];
const out = process.argv[3];
if (!url) {
  console.error("usage: node scripts/fetch-page.mjs <url> [outfile]");
  process.exit(64);
}

async function version() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

let v = await version();
if (!v) {
  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
    process.exit(2);
  }
  fs.rmSync(PROFILE, { recursive: true, force: true });
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
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    v = await version();
    if (v) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!v) {
  console.error("chrome did not come up on port " + PORT);
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let target = list.find((t) => t.type === "page") ?? list[0];
if (!target) {
  target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json();
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg.method);
  }
};
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res) => {
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1400,
  height: 2000,
  deviceScaleFactor: 1,
  mobile: false,
});

const nav = await send("Page.navigate", { url });
if (nav.result?.errorText) console.error("nav error:", nav.result.errorText);

// Give the WAF interstitial time to run and the real page time to paint.
await sleep(WAIT_MS);
for (let i = 0; i < 12; i++) {
  const rs = await send("Runtime.evaluate", {
    expression: "document.readyState",
    returnByValue: true,
  });
  if (rs.result?.result?.value === "complete") break;
  await sleep(500);
}
// A couple of catalogs re-fetch their own sections after load; one more beat helps.
await sleep(1200);

const html = await send("Runtime.evaluate", {
  expression: "document.documentElement ? document.documentElement.outerHTML : ''",
  returnByValue: true,
});
const body = html.result?.result?.value ?? "";
const finalUrl = await send("Runtime.evaluate", {
  expression: "location.href",
  returnByValue: true,
});

if (!body || body.length < 500) {
  console.error(`rendered body too small (${body.length} bytes) at ${finalUrl.result?.result?.value}`);
  process.exit(2);
}

if (out) {
  fs.mkdirSync(out.includes("/") && out.lastIndexOf("/") > 0 ? out.slice(0, out.lastIndexOf("/")) : ".", {
    recursive: true,
  });
  fs.writeFileSync(out, body);
  console.error(`${url} -> ${out} (${body.length} bytes)`);
} else {
  process.stdout.write(body);
}
ws.close();
