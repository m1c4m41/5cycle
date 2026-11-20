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
 * Await `p` but give up after `ms`. The loser keeps running in the
 * background (the driver offers no cancellation), so callers that rely on
 * the timeout must be prepared for that — tx() force-closes its stream,
 * which makes the leftover work fail fast.
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms: ${what}`)),
      ms,
    );
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Execute a statement on the current transaction if there is one, otherwise
 * standalone on the client.
 */
const txTail = new WeakMap<Transaction, Promise<unknown>>();
async function exec(sql: string, params: SqlValue[] = []): Promise<ResultSet> {
  await boot();
  const t = txStore.getStore();
  if (!t) return client().execute(sql, params);
  // Helpers fan out with Promise.all; a single transaction is one ordered
  // stream, so statements inside it are chained rather than interleaved.
  const prev = txTail.get(t) ?? Promise.resolve();
  const next = prev.then(
    () => t.execute({ sql, args: params }),
    () => t.execute({ sql, args: params }),
  );
  txTail.set(t, next.catch(() => undefined));
  return next;
}

let bootPromise: Promise<void> | null = null;
function boot(): Promise<void> {
  if (!bootPromise) bootPromise = doBoot();
  return bootPromise;
}

/** Bump when the guarded ALTER/rebuild steps in runSchemaMigrations change. */
const MIGRATION_REV = "2";
const BOOT_DDL_TIMEOUT_MS = Number(process.env.CYCLE_BOOT_DDL_TIMEOUT_MS) || 15_000;

/**
 * Schema DDL + the two guarded post-creation migrations. Idempotent — safe
 * to run on every process start, local or remote, first or later. On Turso
 * these are writes, so they queue behind any open write transaction (e.g. a
 * catalog sync holding the lock).
 */
async function runSchemaMigrations(d: Client): Promise<void> {
  const ddl = fs.readFileSync(SCHEMA_PATH, "utf8");
  // Remote only: one cheap READ tells us the schema is already current, so a
  // cold start skips the whole write-heavy DDL pass. The stamp is the hash of
  // schema.sql plus MIGRATION_REV (bump it when the ALTER/rebuild guards below
  // change), written only after a full successful pass.
  const version = crypto.createHash("sha1").update(ddl).update(MIGRATION_REV).digest("hex");
  if (REMOTE_DB) {
    try {
      const rs = await d.execute("SELECT value FROM meta WHERE key = 'schema_version'");
      if (String(rs.rows[0]?.[0] ?? "") === version) return;
    } catch {
      /* meta missing on a brand-new database — fall through to full setup */
    }
  }
  await d.executeMultiple(ddl);

  // schema.sql is CREATE TABLE IF NOT EXISTS, so columns added after the
  // first boot need explicit ALTERs here. Each guard is idempotent.
  const userCols = await d.execute("PRAGMA table_info(users)");
  const hasMajor2 = userCols.rows.some((r) => String(r[1]) === "major2_id");
  if (!hasMajor2) {
    await d.execute("ALTER TABLE users ADD COLUMN major2_id TEXT");
  }
  if (!userCols.rows.some((r) => String(r[1]) === "email_verified_at")) {
    await d.execute("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
  }
  if (!userCols.rows.some((r) => String(r[1]) === "notify_email")) {
    await d.execute("ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 0");
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

  if (REMOTE_DB) {
    await d.execute({
      sql: "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [version],
    });
  }
}

let schemaRetryScheduled = false;
function scheduleSchemaRetry(): void {
  if (schemaRetryScheduled) return;
  schemaRetryScheduled = true;
  const timer = setTimeout(() => {
    schemaRetryScheduled = false;
    void runSchemaMigrations(client()).then(
      () => console.log("[db] deferred schema check completed"),
      (e) => {
        console.warn(
          `[db] deferred schema check failed (${e instanceof Error ? e.message : e}); retrying`,
        );
        scheduleSchemaRetry();
      },
    );
  }, 60_000);
  timer.unref?.();
}

/**
 * Idempotent boot: pragmas (file mode only), then the schema check.
 *
 * Remote mode bounds the schema check: if another connection holds Turso's
 * write lock (a stalled catalog sync did exactly this once and took the whole
 * site down, because every request awaited boot's DDL), we serve traffic from
 * the already-existing tables and retry in the background instead of wedging
 * every request. File mode has no such contention, so a failure there is a
 * real schema error and is rethrown as before.
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
    await runSchemaMigrations(d);
    return;
  }
  try {
    await withTimeout(
      runSchemaMigrations(d),
      BOOT_DDL_TIMEOUT_MS,
      "schema check (another connection holds the write lock)",
    );
  } catch (e) {
    console.warn(
      `[db] boot: schema check deferred — ${e instanceof Error ? e.message : e}; ` +
        "serving from existing tables, retrying in 60s",
    );
    scheduleSchemaRetry();
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
const TX_STREAM_TIMEOUT_MS = Number(process.env.CYCLE_TX_STREAM_TIMEOUT_MS) || 10_000;
/** A healthy full 3-term section sync takes ~5 s; 5 minutes is a big margin. */
const TX_BODY_TIMEOUT_MS = Number(process.env.CYCLE_TX_BODY_TIMEOUT_MS) || 5 * 60_000;
const TX_CLOSE_TIMEOUT_MS = 15_000;

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("timed out after");
}

function forceCloseTx(t: Transaction): void {
  // Aborts the underlying stream: the server rolls the transaction back and
  // releases the write lock. No-op if already closed.
  try {
    if (!t.closed) t.close();
  } catch {
    /* already closed */
  }
}

export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  await boot();
  // Opening the stream is cheap; the actual BEGIN IMMEDIATE (and any lock
  // wait) happens with the first statement inside fn.
  const t = await withTimeout(
    client().transaction("write"),
    TX_STREAM_TIMEOUT_MS,
    "opening write transaction",
  );
  try {
    // A single hung statement would otherwise hold Turso's write lock for
    // the life of the process (it once did, and blocked every other boot's
    // schema check site-wide). Bound the body; on timeout force-close the
    // transaction — releasing the lock — and fail with a retryable error.
    const body = txStore.run(t, fn);
    body.catch(() => {}); // surfaced via the race below; keeps Node quiet on timeout
    const out = await withTimeout(body, TX_BODY_TIMEOUT_MS, "write transaction body");
    const commit = t.commit();
    commit.catch(() => {});
    await withTimeout(commit, TX_CLOSE_TIMEOUT_MS, "commit");
    return out;
  } catch (err) {
    if (isTimeoutError(err)) {
      // The stream is stalled — a graceful ROLLBACK would hang on it too.
      forceCloseTx(t);
    } else {
      try {
        const rb = t.rollback();
        rb.catch(() => {});
        await withTimeout(rb, TX_CLOSE_TIMEOUT_MS, "rollback");
      } catch {
        forceCloseTx(t);
      }
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
