/**
 * Browser (with-JS) regression check for the guest "browse, then add" flow:
 *   guest opens /catalog -> clicks "Add to plan" -> bounced to /login?add=...
 *   with a pending notice -> logs in -> back on the catalog with ?ok= banner
 *   and the section flipped to "In your plan ✓ (remove)".
 *
 * Needs the app running on :3000 and headless Chrome on :9222
 * (same prerequisites as scripts/check-style.mjs). Creates and removes its
 * own throwaway probe account; never touches qa@5cycle.app.
 *
 *   node scripts/check-guest-flow.mjs
 */
import { spawnSync } from "node:child_process";

const BASE = "http://localhost:3000";
const PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- probe account ------------------------- */
const email = `probe-cdp-${Date.now()}@5cycle.app`;
const password = "probe-claremont5";
const created = await fetch(`${BASE}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "CDP Probe", email, password, school: "CM", gradYear: 2028 }),
});
if (!created.ok) {
  console.error(`could not create probe account: HTTP ${created.status}`);
  process.exit(2);
}

/* ----------------------------- cleanup ---------------------------- */
const cleanup = () => spawnSync("node", ["scripts/cleanup-probe.mjs"], { stdio: "ignore" });
process.on("exit", cleanup);

/* ------------------------------- CDP ------------------------------ */
let fails = 0;
try {
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("websocket error"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? m.error ?? {});
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(`eval: ${JSON.stringify(exceptionDetails)}`);
    return result?.value;
  };
  const waitUrl = async (pred, timeoutMs = 20000) => {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < timeoutMs) {
      last = await ev("location.href");
      if (pred(last)) return last;
      await sleep(250);
    }
    throw new Error(`timed out waiting for URL (last: ${last})`);
  };
  const check = (cond, msg) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
    if (!cond) fails++;
  };

  console.log("== guest opens /catalog?term=SP2027");
  await send("Page.enable");
  await send("Network.enable");
  // Be hermetic: previous checks (e.g. render-check) may have left a
  // cycle_session cookie in this shared browser profile.
  const { cookies } = await send("Network.getCookies", { urls: [BASE] });
  for (const c of cookies ?? []) {
    if (c.name === "cycle_session") {
      await send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
    }
  }
  await send("Page.navigate", { url: `${BASE}/catalog?term=SP2027` });
  await waitUrl((u) => u.includes("/catalog"));
  await sleep(1200); // let hydration settle
  const navIsGuest = await ev(
    `!!document.querySelector('a[href="/login"]') && !document.querySelector('a[href="/profile"]')`,
  );
  check(navIsGuest, "nav shows Sign in (guest), no Account link");
  const firstSection = await ev(
    `(() => { const f = [...document.querySelectorAll('form')].find(x => x.querySelector('input[name="sectionId"]')); return f ? f.querySelector('input[name="sectionId"]').value : null; })()`,
  );
  check(Boolean(firstSection), `found guest "Add to plan" form (section ${firstSection})`);
  const clicked = await ev(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Add to plan'); if (b) { b.click(); return true; } return false; })()`,
  );
  check(clicked, "clicked the first 'Add to plan' button");

  console.log("== expects redirect to /login?add=...");
  const loginUrl = await waitUrl((u) => u.includes("/login"));
  check(
    loginUrl.includes(`add=${firstSection}`),
    `login URL carries the pending course (${new URL(loginUrl).search})`,
  );
  await sleep(800);
  check(
    await ev(`document.body.innerText.includes('added to your plan automatically')`),
    "login page shows the pending-add notice",
  );
  check(
    await ev(`!!document.querySelector('form input[name="add"][value="${firstSection}"]')`),
    "login form carries the hidden add field (survives the round trip)",
  );

  console.log("== fills credentials and submits the login form");
  await ev(
    `(() => {
      const f = document.querySelector('form input[name="email"]').closest('form');
      const set = (name, value) => {
        const el = f.querySelector('input[name="' + name + '"]');
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        desc.set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('email', ${JSON.stringify(email)});
      set('password', ${JSON.stringify(password)});
      f.querySelector('button[type="submit"]').click();
      return true;
    })()`,
  );
  const backUrl = await waitUrl((u) => !u.includes("/login"));
  check(backUrl.includes("ok="), `redirected back with ?ok= notice (${new URL(backUrl).search})`);
  check(backUrl.includes("term=SP2027"), "returned to the originating catalog term");
  await sleep(1500); // re-render + hydrate

  console.log("== catalog shows the course as planned");
  check(
    await ev(`document.body.innerText.includes('added to your plan')`),
    "success banner rendered on /catalog",
  );
  check(
    await ev(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('In your plan'))`,
    ),
    "button flipped to 'In your plan ✓ (remove)'",
  );
  check(await ev(`!!document.querySelector('a[href="/profile"]')`), "nav now shows Account");

  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`, { method: "PUT" }).catch(
    () => {},
  );
} catch (err) {
  fails++;
  console.error(`  FAIL  ${err.message}`);
}

console.log(fails === 0 ? "ALL GUEST-FLOW CHECKS PASSED" : `${fails} GUEST-FLOW CHECKS FAILED`);
process.exit(fails === 0 ? 0 : 1);
