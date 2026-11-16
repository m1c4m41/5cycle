/**
 * SQLite access layer built on Node's built-in `node:sqlite` — no native
 * build step, no ORM. Everything server-side goes through here.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.CYCLE_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = resolveDbPath();
const SCHEMA_PATH = path.join(process.cwd(), "lib", "schema.sql");

/**
 * Where the database lives. Local checkouts use data/db.sqlite as before.
 * Serverless deploys (Vercel) ship a read-only snapshot of the catalog —
 * data/db.snapshot.sqlite, excluded from git but included in the bundle —
 * and seed a writable copy from it the first time the database is opened.
 */
function resolveDbPath(): string {
  const file = process.env.CYCLE_DB_PATH || path.join(DATA_DIR, "db.sqlite");
  if (fs.existsSync(file)) return file;
  const snapshot = path.join(process.cwd(), "data", "db.snapshot.sqlite");
  if (!fs.existsSync(snapshot)) return file; // fresh local checkout: schema-only boot
  const seed = (target: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(snapshot, target);
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(target + suffix, { force: true });
  };
  try {
    seed(file); // e.g. CYCLE_DATA_DIR=/tmp/5cycle on Vercel
  } catch {
    const tmpFile = path.join("/tmp", "5cycle", "db.sqlite");
    if (!fs.existsSync(tmpFile)) seed(tmpFile);
    return tmpFile; // read-only target (e.g. the Vercel bundle itself)
  }
  return file;
}

export type SqlValue = string | number | bigint | null | Uint8Array;

let instance: DatabaseSync | null = null;
let migrated = false;

export function db(): DatabaseSync {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  instance = new DatabaseSync(DB_PATH);
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");
  instance.exec("PRAGMA busy_timeout = 4000");
  if (!migrated) {
    instance.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
    // schema.sql is CREATE TABLE IF NOT EXISTS, so columns added after the
    // first boot need explicit ALTERs here. Each guard is idempotent.
    const userCols = instance
      .prepare("PRAGMA table_info(users)")
      .all() as unknown as { name: string }[];
    if (!userCols.some((c) => c.name === "major2_id")) {
      instance.exec("ALTER TABLE users ADD COLUMN major2_id TEXT");
    }
    // requirement_assignments grew from "one lock per section" to
    // "multi-box per course" (UNIQUE(user_id,section_id) ->
    // UNIQUE(user_id,section_id,group_id) + optional manual_id). SQLite
    // cannot drop a constraint, so rebuild the table when the old shape is
    // detected; existing rows carry over unchanged.
    const asnSql = (
      instance
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='requirement_assignments'",
        )
        .get() as { sql: string } | undefined
    )?.sql ?? "";
    if (asnSql && !asnSql.includes("manual_id")) {
      instance.exec(`
        CREATE TABLE requirement_assignments_new (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          section_id  TEXT REFERENCES sections(id) ON DELETE CASCADE,
          manual_id   TEXT REFERENCES manual_courses(id) ON DELETE CASCADE,
          set_id      TEXT NOT NULL REFERENCES requirement_sets(id) ON DELETE CASCADE,
          group_id    TEXT NOT NULL REFERENCES requirement_groups(id) ON DELETE CASCADE,
          note        TEXT,
          created_at  TEXT NOT NULL,
          UNIQUE (user_id, section_id, group_id),
          UNIQUE (user_id, manual_id, group_id)
        );
        INSERT INTO requirement_assignments_new
          (id, user_id, section_id, manual_id, set_id, group_id, note, created_at)
          SELECT id, user_id, section_id, NULL, set_id, group_id, note, created_at
          FROM requirement_assignments;
        DROP TABLE requirement_assignments;
        ALTER TABLE requirement_assignments_new RENAME TO requirement_assignments;
        CREATE INDEX IF NOT EXISTS ix_assign_user ON requirement_assignments(user_id);
      `);
    }
    migrated = true;
  }
  return instance;
}

export function dbPath() {
  return DB_PATH;
}

/** SELECT many. */
export function all<T = Record<string, unknown>>(
  sql: string,
  params: SqlValue[] = [],
): T[] {
  return db()
    .prepare(sql)
    .all(...params) as T[];
}

/** SELECT one (or undefined). */
export function get<T = Record<string, unknown>>(
  sql: string,
  params: SqlValue[] = [],
): T | undefined {
  return db()
    .prepare(sql)
    .get(...params) as T | undefined;
}

/** INSERT / UPDATE / DELETE. */
export function run(sql: string, params: SqlValue[] = []) {
  return db()
    .prepare(sql)
    .run(...params);
}

/** Wrapped in BEGIN/COMMIT so a bad ingest can't leave half a term loaded. */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export function isEmpty(): boolean {
  const row = get<{ n: number }>("SELECT COUNT(*) AS n FROM sections");
  return !row || Number(row.n) === 0;
}

export function newId(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function setMeta(key: string, value: string) {
  run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export function getMeta(key: string): string | undefined {
  const row = get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
  return row?.value;
}
