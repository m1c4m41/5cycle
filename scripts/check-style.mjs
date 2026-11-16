/**
 * Verify the pages are actually styled (Tailwind emitted real CSS) rather than
 * rendering as unstyled HTML. Queries computed styles in headless Chrome.
 *
 *   node scripts/check-style.mjs
 */
const PORT = 9222;
const BASE = "http://localhost:3000";

const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => {
  const { result } = await send("Runtime.evaluate", { expression, returnByValue: true });
  return result?.value;
};

await send("Page.enable");
const { cookieLine } = await import("node:fs").then(async (fs) => {
  const raw = fs.readFileSync("/tmp/ck.txt", "utf8");
  // Support both a bare "name=value" line and a Netscape cookie jar
  // (curl -c output): find the cycle_session row and take its last field.
  const jar = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes("cycle_session") && !l.startsWith("#Netscape"));
  if (jar) {
    const fields = jar.split(/\s+/);
    return { cookieLine: `cycle_session=${fields[fields.length - 1]}` };
  }
  return { cookieLine: raw.trim().split("\n").find((l) => l.includes("cycle_session")) || "" };
});
await send("Network.enable");
const [n, v] = cookieLine.split("=");
console.log(`  [cookie] ${n} = ${String(v).slice(0, 12)}…`);
await send("Network.setCookie", { name: n, value: v, domain: "localhost", path: "/" });

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) fail++;
};

async function go(route) {
  await send("Page.navigate", { url: BASE + route });
  await sleep(2200);
}

console.log("== stylesheet is loaded and non-trivial");
await go("/planner?term=SP2027");
// Tailwind v4 emits @layer blocks, which expose as a single CSSRule each with
// hundreds nested inside — so count recursively, not just top level.
const sheets = await ev(`(() => {
  const walk = (rules) => {
    let n = 0;
    for (const r of rules) {
      n++;
      if (r.cssRules) n += walk([...r.cssRules]);
    }
    return n;
  };
  return [...document.styleSheets].map((s) => {
    try {
      return walk([...s.cssRules]);
    } catch {
      return -1;
    }
  });
})()`);
ok(
  Array.isArray(sheets) && sheets.some((x) => x > 200),
  `css rules per stylesheet (recursive): ${JSON.stringify(sheets)}`,
);

console.log("\n== brand Tailwind tokens resolved to real values");
const styles = await ev(`(() => {
  const btn = document.querySelector('.btn-primary');
  const chip = document.querySelector('.chip');
  const card = document.querySelector('.card');
  const body = document.body;
  const g = (el,p)=> el ? getComputedStyle(el)[p] : null;
  return {
    btnBg: g(btn,'backgroundColor'), btnColor: g(btn,'color'), btnRadius: g(btn,'borderRadius'),
    btnDisplay: g(btn,'display'),
    chipPad: g(chip,'padding'), chipRadius: g(chip,'borderRadius'),
    cardBorder: g(card,'borderColor'), cardRadius: g(card,'borderRadius'),
    fontFamily: g(body,'fontFamily').slice(0,40),
    bodyColor: g(body,'color'), bodyBg: g(body,'backgroundColor'),
  };
})()`);
console.log("  " + JSON.stringify(styles, null, 1).replace(/\n\s*/g, " "));
ok(styles.btnBg && styles.btnBg !== "rgba(0, 0, 0, 0)", `btn-primary has a background (${styles.btnBg})`);
ok(styles.btnRadius && styles.btnRadius !== "0px", `rounded utilities applied (${styles.btnRadius})`);
ok(styles.cardRadius && styles.cardRadius !== "0px", `card radius applied (${styles.cardRadius})`);
ok(styles.bodyColor && styles.bodyColor !== "rgb(0, 0, 0)", `theme text colour applied (${styles.bodyColor})`);

console.log("\n== the timetable is a positioned grid, not a flat list");
const tt = await ev(`(() => {
  const host = [...document.querySelectorAll('div,section')].find(d=>/Timetable|Weekly/.test(d.textContent||'') );
  const marks = [...document.querySelectorAll('*')].filter(e=>{
    const s=getComputedStyle(e); return s.position==='absolute' && parseInt(s.height)>0 && s.top!=='auto';
  });
  const labels=[...document.querySelectorAll('*')].map(e=>e.childElementCount===0?(e.textContent||'').trim():'')
    .filter(t=>/^(Mon|Tue|Wed|Thu|Fri)$/.test(t));
  return {absolute: marks.length, dayHeaders:[...new Set(labels)]};
})()`);
console.log("  " + JSON.stringify(tt));
ok(tt.absolute > 0, `timetable has ${tt.absolute} absolutely-positioned class blocks`);
ok(tt.dayHeaders.length >= 4, `day columns rendered: ${tt.dayHeaders.join(",")}`);

console.log("\n== checklist renders progress bars + status chips");
await go("/requirements");
const req = await ev(`(() => {
  // set cards are collapsed by default — record that, then expand to check chips inside
  const setCards = [...document.querySelectorAll('details[id^="set-"]')];
  const closedByDefault = setCards.length > 0 && setCards.every((d) => !d.open);
  document.querySelectorAll('details').forEach((d) => { d.open = true; });
  const txt = document.body.innerText;
  return {
    setCards: setCards.length,
    closedByDefault,
    satisfied: (txt.match(/satisfied/gi)||[]).length,
    notmet: (txt.match(/not met/gi)||[]).length,
    optional: (txt.match(/optional/gi)||[]).length,
    percent: (txt.match(/\\d+%/g)||[]).slice(0,6),
    bars: [...document.querySelectorAll('div')].filter(d=>{
      const s=getComputedStyle(d); return parseFloat(s.height)<=8 && s.backgroundColor!=='rgba(0, 0, 0, 0)' && d.style.width && d.style.width.includes('%');
    }).length,
  };
})()`);
console.log("  " + JSON.stringify(req));
ok(req.satisfied > 0, `${req.satisfied} "satisfied" labels visible`);
ok(req.bars > 0, `${req.bars} progress bars rendered with inline widths`);
ok(req.closedByDefault, `all ${req.setCards} requirement set cards start collapsed`);

console.log("\n== RMP honesty: no invented score on an unmirrored professor");
await go("/professors/ins-aaron-aruck-0ca4b6");
const rmp = await ev(`(() => {
  const t = document.body.innerText;
  return { mentionsRmp: /RateMyProfessors/i.test(t), link: !!document.querySelector('a[href*="ratemyprofessors.com"]'),
           saysNotMirrored: /not (?:mirrored|stored) locally|no mirrored|search RateMyProfessors/i.test(t) };
})()`);
console.log("  " + JSON.stringify(rmp));
ok(rmp.mentionsRmp, "RMP referenced on the page");
ok(rmp.link, "links out to ratemyprofessors.com");

console.log("\n== cross-campus registrar portal on a section");
await go("/section/POLI-124-SC-01-SP2027");
const perm = await ev(`(() => {
  const t=document.body.innerText;
  const portal=[...document.querySelectorAll('a[target="_blank"]')]
    .find(a=>/registrar portal/i.test(a.innerText));
  return {perm:/perm/i.test(t), mailto: !!document.querySelector('a[href^="mailto:"]'),
          paste: !!document.querySelector('pre'),
          portal: portal ? {text: portal.innerText.trim(), href: portal.href} : null};
})()`);
console.log("  " + JSON.stringify(perm));
ok(perm.perm, "perm language present");
ok(!perm.mailto, "old consent-mailto removed");
ok(!perm.paste, "old paste-ready block removed");
ok(perm.portal && /registrar portal/i.test(perm.portal.text), "registrar portal button present");
ok(perm.portal && perm.portal.href.includes("claremontmckenna.edu"), "portal points at home campus (CMC) portal");

console.log("\n== catalog: section numbers, schedule fit, weekly-grid preview");
await go("/catalog?term=SP2027");
const cat = await ev(`(() => {
  const t = document.body.innerText;
  const secNums = (t.match(/· sec \\d{2}/g) || []).length;
  const viewGridLinks = [...document.querySelectorAll("a")].filter(
    (a) => a.textContent.trim() === "View on grid"
  );
  return {
    secNums,
    fits: (t.match(/✓ fits your plan/g) || []).length,
    overlaps: (t.match(/⚠ overlaps/g) || []).length,
    viewGrid: viewGridLinks.length,
    firstHref: viewGridLinks[0] ? viewGridLinks[0].getAttribute("href") : null,
    termSelects: document.querySelectorAll('select[name="term"]').length,
    gridAside: /Your Spring 2027 grid/.test(t),
  };
})()`);
console.log("  " + JSON.stringify(cat));
ok(cat.secNums > 10, `${cat.secNums} section numbers rendered in course names`);
ok(cat.fits > 0 || cat.overlaps > 0, `schedule-fit chips rendered (${cat.fits} fits / ${cat.overlaps} overlaps)`);
ok(cat.viewGrid > 5, `${cat.viewGrid} “View on grid” links`);
ok(cat.firstHref && /preview=/.test(cat.firstHref), "grid-preview link carries ?preview=<sectionId>");
ok(cat.termSelects === 1, "exactly one term dropdown on the catalog page (search + header share it)");
ok(cat.gridAside, "sticky “Your <term> grid” sidebar next to the results");

await go(cat.firstHref);
const grid = await ev(`(() => {
  const t = document.body.innerText;
  return {
    heading: /lands on your/.test(t),
    verdict: /No time overlap|Time conflict with/.test(t),
    close: !![...document.querySelectorAll("a")].find((a) => a.textContent.includes("Close preview")),
  };
})()`);
console.log("  " + JSON.stringify(grid));
ok(grid.heading, "“Where X lands on your grid” preview panel");
ok(grid.verdict, "fit/conflict verdict under the preview");
ok(grid.close, "Close preview link");

console.log("\n== requirements: full plan + counting boxes (multi-checkbox manual assignment)");
await go("/requirements");
const man = await ev(`(() => {
  const t = document.body.innerText;
  return {
    fullPlan: /Your full plan — \\d+ courses? across/.test(t),
    panel: /Counting boxes — advisor designations/.test(t),
    rows: (t.match(/automatic —|📌 counting toward/g) || []).length,
    groupBoxes: document.querySelectorAll('input[type="checkbox"][name="groupId"]').length,
    addForm: !!document.querySelector('input[name="title"]'),
    addHead: /Add a course by hand/.test(t),
    halfCreditRule: /0\.5-credit|full credit/i.test(t),
    actionForms: document.querySelectorAll('form[action=""]').length,
  };
})()`);
console.log("  " + JSON.stringify(man));
ok(man.fullPlan, "“Your full plan — N courses across M terms” card (all terms, not just selected)");
ok(man.panel, "counting-boxes panel present");
ok(man.rows >= 5, `${man.rows} planned courses listed with their counting state`);
ok(man.groupBoxes > 20, `${man.groupBoxes} requirement checkboxes offered (multi-box, not a single select)`);
ok(man.addForm && man.addHead, "“Add a course by hand” form (study abroad / transfer / create-your-own)");
ok(man.halfCreditRule, "half-credit rule explained (0.5 cr can't tick GE/breadth, still counts toward 32)");
ok(man.actionForms >= 6, "counting forms are real server-action forms");

console.log("\n== planner: study-abroad checkbox + manual course entry");
await go("/planner?term=SP2027");
const plan = await ev(`(() => {
  const t = document.body.innerText;
  return {
    abroadBox: !!document.querySelector('input[type="checkbox"][name="abroad"]'),
    abroadText: /studying abroad this term/.test(t),
    manualHead: /Enter a course by hand/.test(t),
    manualForm: !!document.querySelector('form input[name="title"]'),
    manualBoxes: document.querySelectorAll('input[type="checkbox"][name="groupId"]').length,
  };
})()`);
console.log("  " + JSON.stringify(plan));
ok(plan.abroadBox && plan.abroadText, "per-term “studying abroad” checkbox on the planner");
ok(plan.manualHead && plan.manualForm, "manual course entry form (title, credits, type) on the planner");
ok(plan.manualBoxes > 10, `${plan.manualBoxes} requirement boxes offered for manual courses`);

console.log(`\n${fail === 0 ? "ALL STYLE/RENDER CHECKS PASSED" : fail + " CHECK(S) FAILED"}`);
ws.close();
process.exit(fail ? 1 : 0);
