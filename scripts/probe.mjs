/**
 * Run a read-only SQL probe and print the rows as JSON.
 *
 *   node scripts/probe.mjs "SELECT ... [LIMIT n]"
 *
 * Uses the same backend the server does: Turso when
 * TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set (see lib/db.ts REMOTE_DB),
 * otherwise the local data/db.sqlite file.
 */
// Standalone scripts don't inherit the Next.js env: fall back to .env.local
// for any variable not already set (same values the dev server uses).
import fs from "node:fs";
import path from "node:path";
{
  const envFile = path.resolve(import.meta.dirname, "..", ".env.local");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const sql = process.argv[2] ?? "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";

function print(rows) {
  console.log(JSON.stringify(rows, (k, v) => (v === null ? null : v), 1).slice(0, 4000));
}

if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
  });
  const res = await c.execute(sql);
  print(res.rows);
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("data/db.sqlite");
  print(db.prepare(sql).all());
}
