/**
 * SQLite access layer built on @libsql/client — one driver, two backends:
 *
 *   - local dev / Mac:  a `file:` database at data/db.sqlite (a fresh checkout
 *     is seeded from the bundled data/db.snapshot.sqlite, as before)
 *   - Vercel / prod:    Turso (env TURSO_DATABASE_URL + TURSO_AUTH_TOKEN), so
 *     student data survives cold starts and redeploys
 *
 * Everything server-side goes through the helpers below; they are all async.
 * No caller touches the driver directly.
 *
 * Concurrency model: standalone statements each run on their own logical
 * connection. Multi-statement sequences must be wrapped in tx(), which starts
 * a write transaction and routes every helper call made inside it (including
 * nested function calls) onto that same transaction via AsyncLocalStorage —
 * so a failed ingest can't leave half a term loaded.
 *
 * NOTE on foreign keys: Turso connections do not keep per-connection pragmas,
 * so cascades are NOT relied on anywhere in this codebase. Deletes that used
 * to lean on ON DELETE CASCADE clean up their children explicitly (see
 * lib/ingest.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createClient,
  type Client,
  type InValue,
  type ResultSet,
  type Transaction,
} from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type SqlValue = InValue;
export interface RunResult {
  changes: number;
  lastInsertRowid: bigint | number | undefined;
}

const DATA_DIR = process.env.CYCLE_DATA_DIR || path.join(process.cwd(), "data");
const SCHEMA_PATH = path.join(process.cwd(), "lib", "schema.sql");

export const REMOTE_DB = Boolean(
  process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN,
);

/**
 * Where the local (file:) database lives. Local checkouts use data/db.sqlite
 * as before. A fresh checkout without a DB is seeded from the bundled
 * data/db.snapshot.sqlite; if the target dir is read-only (e.g. the Vercel
 * bundle), the seed falls back to /tmp/5cycle/db.sqlite. Unused when
 * REMOTE_DB is true.
 */
function resolveDbPath(): string {
  const file = process.env.CYCLE_DB_PATH || path.join(DATA_DIR, "db.sqlite");
  if (fs.existsSync(file)) return file;
  const snapshot = path.join(process.cwd(), "data", "db.snapshot.sqlite");
  if (!fs.existsSync(snapshot)) return file; // truly fresh: schema-only boot
  const seed = (target: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(snapshot, target);
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(target + suffix, { force: true });
  };
  try {
    seed(file);
  } catch {
    const tmpFile = path.join("/tmp", "5cycle", "db.sqlite");
    if (!fs.existsSync(tmpFile)) seed(tmpFile);
    return tmpFile; // read-only target (e.g. the Vercel bundle itself)
  }
  return file;
}

const DB_PATH = REMOTE_DB ? "" : resolveDbPath();

let instance: Client | null = null;

export function dbPath(): string {
  return DB_PATH;
}

function client(): Client {
  if (instance) return instance;
  if (REMOTE_DB) {
    instance = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
      intMode: "number",
    });
  } else {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    instance = createClient({
      url: `file:${DB_PATH}`,
      intMode: "number",
      timeout: 4000,
    });
  }
  return instance;
}

/** Transaction routed to inner helper calls via AsyncLocalStorage. */
const txStore = new AsyncLocalStorage<Transaction>();

/**
 * Execute a statement on the current transaction if there is one, otherwise
 * standalone on the client.
 */
async function exec(sql: string, params: SqlValue[] = []): Promise<ResultSet> {
  await boot();
  const t = txStore.getStore();
  if (t) return t.execute({ sql, args: params });
  return client().execute(sql, params);
}

let bootPromise: Promise<void> | null = null;
function boot(): Promise<void> {
  if (!bootPromise) bootPromise = doBoot();
  return bootPromise;
}

/**
 * Idempotent boot: pragmas (file mode only), schema (CREATE ... IF NOT
 * EXISTS), then the two post-creation column migrations. Safe to run on every
 * process start, local or remote, first or later.
 */
async function doBoot(): Promise<void> {
  const d = client();
  if (!REMOTE_DB) {
    try {
      await d.execute("PRAGMA journal_mode = WAL");
    } catch {
      /* read-only fs */
    }
    try {
      await d.execute("PRAGMA foreign_keys = ON");
    } catch {
      /* ignore */
    }
  }
  await d.executeMultiple(fs.readFileSync(SCHEMA_PATH, "utf8"));

  // schema.sql is CREATE TABLE IF NOT EXISTS, so columns added after the
  // first boot need explicit ALTERs here. Each guard is idempotent.
  const userCols = await d.execute("PRAGMA table_info(users)");
  const hasMajor2 = userCols.rows.some((r) => String(r[1]) === "major2_id");
  if (!hasMajor2) {
    await d.execute("ALTER TABLE users ADD COLUMN major2_id TEXT");
  }

  // requirement_assignments grew from "one lock per section" to
  // "multi-box per course" (UNIQUE(user_id,section_id) ->
  // UNIQUE(user_id,section_id,group_id) + optional manual_id). SQLite
  // cannot drop a constraint, so rebuild the table when the old shape is
  // detected; existing rows carry over unchanged.
  const asnRs = await d.execute(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='requirement_assignments'",
  );
  const asnSql = String(asnRs.rows[0]?.[0] ?? "") || "";
  if (asnSql && !asnSql.includes("manual_id")) {
    await d.executeMultiple(`
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
}

/** SELECT many. */
export async function all<T = Record<string, unknown>>(
  sql: string,
  params: SqlValue[] = [],
): Promise<T[]> {
  const rs = await exec(sql, params);
  return rs.rows as unknown as T[];
}

/** SELECT one (or undefined). */
export async function get<T = Record<string, unknown>>(
  sql: string,
  params: SqlValue[] = [],
): Promise<T | undefined> {
  const rs = await exec(sql, params);
  return (rs.rows[0] as T | undefined) ?? undefined;
}

/** INSERT / UPDATE / DELETE. */
export async function run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
  const rs = await exec(sql, params);
  return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid };
}

/**
 * Wrapped in a write transaction (BEGIN IMMEDIATE on the server) so a bad
 * ingest can't leave half a term loaded. `fn` must await the db helpers;
 * they are routed onto the transaction automatically, including through
 * nested function calls.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  await boot();
  const t = await client().transaction("write");
  try {
    const out = await txStore.run(t, fn);
    await t.commit();
    return out;
  } catch (err) {
    try {
      await t.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export async function isEmpty(): Promise<boolean> {
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM sections");
  return !row || Number(row.n) === 0;
}

export function newId(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function setMeta(key: string, value: string): Promise<void> {
  await run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
  return row?.value;
}
