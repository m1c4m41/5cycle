#!/usr/bin/env node
/**
 * One-time (re-runnable) seed: copy the local catalog database into Turso.
 *
 *   node scripts/seed-turso.mjs [--keep]
 *
 * Without --keep the remote database is wiped first (children before parents),
 * so the script is idempotent: running it twice leaves the same state.
 *
 * Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment or
 * .env.local in the project root. Source database: data/db.snapshot.sqlite
 * (falls back to data/db.sqlite).
 */
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

// ---- env -----------------------------------------------------------------
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}
loadEnvFile(path.join(root, ".env.local"));

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (env or .env.local).");
  process.exit(1);
}

// ---- source db -------------------------------------------------------------
const srcFile = fs.existsSync(path.join(root, "data", "db.snapshot.sqlite"))
  ? path.join(root, "data", "db.snapshot.sqlite")
  : path.join(root, "data", "db.sqlite");
if (!fs.existsSync(srcFile)) {
  console.error(`Source database not found: ${srcFile}`);
  process.exit(1);
}
const src = new DatabaseSync(srcFile, { readOnly: true });

// Parents first (see lib/schema.sql FKs).
const SEED_ORDER = [
  "terms",
  "sections",
  "instructors",
  "course_areas",
  "section_schedules",
  "section_instructors",
  "section_areas",
  "users",
  "sessions",
  "manual_courses",
  "requirement_sets",
  "requirement_groups",
  "requirement_rules",
  "enrollments",
  "reviews",
  "user_term_flags",
  "requirement_assignments",
  "meta",
];
const WIPE_ORDER = [...SEED_ORDER].reverse();

const keep = process.argv.includes("--keep");

// ---- helpers ---------------------------------------------------------------
function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return "'" + v.replace(/'/g, "''") + "'";
  if (v instanceof Uint8Array) return "X'" + Buffer.from(v).toString("hex") + "'";
  if (v instanceof Date) return "'" + v.toISOString() + "'";
  throw new Error("unseedable value type: " + Object.prototype.toString.call(v));
}

const remote = createClient({ url, authToken: token, intMode: "number" });

async function wipe() {
  console.log("Wiping remote tables...");
  for (const t of WIPE_ORDER) {
    try {
      const rs = await remote.execute(`DELETE FROM ${t}`);
      if (rs.rowsAffected > 0) process.stdout.write(`  ${t}: -${rs.rowsAffected}\n`);
    } catch (e) {
      if (!/no such table/i.test(String(e.message))) throw e; // empty remote: fine
    }
  }
}

async function seedTable(t) {
  const cols = src
    .prepare(`PRAGMA table_info(${t})`)
    .all()
    .map((r) => r.name);
  if (cols.length === 0) {
    console.error(`  !! table ${t} not found in source`);
    process.exit(1);
  }
  const rows = src.prepare(`SELECT * FROM ${t}`).all();
  const colList = cols.map((c) => `"${c}"`).join(",");
  const stmts = rows.map((r) => {
    const vals = cols.map((c) => lit(r[c])).join(",");
    return `INSERT INTO ${t} (${colList}) VALUES (${vals})`;
  });
  let i = 0;
  for (; i < stmts.length; i += 300) {
    // batch() runs each group atomically (one write transaction per call)
    await remote.batch(stmts.slice(i, i + 300));
  }
  return rows.length;
}

// ---- run -------------------------------------------------------------------
try {
  // Make sure the schema exists on the remote (fresh databases are empty).
  const schema = fs.readFileSync(path.join(root, "lib", "schema.sql"), "utf8");
  await remote.executeMultiple(schema);

  if (!keep) await wipe();

  const counts = {};
  console.log(keep ? "Seeding (keep existing rows)... " : "Seeding...");
  for (const t of SEED_ORDER) {
    const n = await seedTable(t);
    counts[t] = n;
    console.log(`  ${t}: +${n}`);
  }

  console.log("\nVerifying remote counts...");
  let bad = 0;
  for (const t of SEED_ORDER) {
    const rs = await remote.execute(`SELECT COUNT(*) AS n FROM ${t}`);
    const remoteN = Number(rs.rows[0][0]);
    const srcN = Number(src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    const ok = remoteN === (keep ? srcN + remoteN - counts[t] : srcN);
    if (!ok) {
      bad++;
      console.log(`  MISMATCH ${t}: remote ${remoteN}, source ${srcN}, inserted ${counts[t]}`);
    }
  }
  const cur = await remote.execute(`SELECT value FROM meta WHERE key='current_term'`);
  console.log(`\ncurrent_term on remote: ${cur.rows[0]?.[0] ?? "(none)"}`);
  if (bad === 0) {
    console.log(`DONE — all ${SEED_ORDER.length} tables match. Turso is seeded.`);
  } else {
    console.log(`DONE with ${bad} mismatch(es).`);
    process.exit(1);
  }
} finally {
  src.close();
  remote.close();
}
