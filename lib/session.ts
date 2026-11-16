/**
 * Minimal, dependency-free account system: scrypt password hashing + HMAC
 * signed session cookie. Swap for the campus SAML/OIDC provider later — the
 * only surface the app depends on is `currentUser()` / `requireUser()`.
 */
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { all, get, newId, nowIso, run } from "./db";
import { hashPassword, verifyPassword } from "./password";
import type { UserRow } from "./types";

// Re-exported so callers (and the CLI, which must not import next/headers) can
// pick the hashing helpers up from either place.
export { hashPassword, verifyPassword };

const COOKIE = "cycle_session";
const DAY = 86400_000;
const SESSION_TTL = 30 * DAY;

function secret(): string {
  const s = process.env.CYCLE_SESSION_SECRET;
  if (s) {
    if (s.length < 16) {
      throw new Error(
        "CYCLE_SESSION_SECRET is shorter than 16 characters — use a long random value (e.g. `openssl rand -hex 32`).",
      );
    }
    return s;
  }
  if (process.env.NODE_ENV === "production") {
    // Fail closed: the fallback below is a publicly known constant, so a
    // production server must never sign cookies with it.
    throw new Error(
      "CYCLE_SESSION_SECRET is not set — refusing to run in production with the dev fallback secret.",
    );
  }
  // Dev fallback so `npm run dev` works with no .env. Never shipped.
  return "5cycle-dev-only-secret-change-me";
}

/* ------------------------------- sessions ------------------------------ */

function sign(token: string): string {
  return crypto.createHmac("sha256", secret()).update(token).digest("base64url");
}

function makeToken(): { cookie: string; stored: string } {
  const token = crypto.randomBytes(24).toString("base64url");
  return { cookie: `${token}.${sign(token)}`, stored: token };
}

function parseToken(value: string): string | null {
  const idx = value.lastIndexOf(".");
  if (idx <= 0) return null;
  const token = value.slice(0, idx);
  const mac = value.slice(idx + 1);
  const expected = sign(token);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return token;
}

export async function startSession(userId: string): Promise<void> {
  const { cookie, stored } = makeToken();
  // Store only the random half. The signature is derived from it, so anything
  // that can read the table still cannot mint a cookie without the HMAC secret
  // — and, critically, the lookup below asks for exactly this value. Storing
  // the signed string meant the query never matched and sessions silently
  // failed for every user.
  await run("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)", [
    stored,
    userId,
    Date.now() + SESSION_TTL,
  ]);
  const jar = await cookies();
  jar.set(COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw) {
    const token = parseToken(raw);
    if (token) await run("DELETE FROM sessions WHERE token = ?", [token]);
  }
  jar.delete(COOKIE);
}

export async function currentUserId(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  const token = parseToken(raw);
  if (!token) return null;
  const row = await get<{ user_id: string; expires_at: number }>(
    "SELECT user_id, expires_at FROM sessions WHERE token = ?",
    [token],
  );
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await run("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  return row.user_id;
}

export async function currentUser(): Promise<UserRow | null> {
  const id = await currentUserId();
  if (!id) return null;
  return (
    (await get<UserRow>(
      `SELECT id, email, name, school, grad_year, major_id, major2_id, minor_id, advisor
       FROM users WHERE id = ?`,
      [id],
    )) ?? null
  );
}

export class Unauthorized extends Error {
  constructor() {
    super("Not signed in");
  }
}

export async function requireUser(): Promise<UserRow> {
  const u = await currentUser();
  if (!u) throw new Unauthorized();
  return u;
}

/* -------------------------------- signup ------------------------------- */

export type SignupInput = {
  name: string;
  email: string;
  password: string;
  school: string;
  gradYear?: number | null;
  majorId?: string | null;
  major2Id?: string | null;
  minorId?: string | null;
};

export async function createUser(input: SignupInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (input.password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (await get("SELECT id FROM users WHERE email = ?", [email]))
    return { ok: false, error: "An account with that email already exists." };

  const id = newId("usr-");
  await run(
    `INSERT INTO users(id, email, name, password_hash, school, grad_year, major_id, major2_id, minor_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      email,
      input.name.trim(),
      hashPassword(input.password),
      input.school,
      input.gradYear ?? null,
      input.majorId || null,
      input.major2Id || null,
      input.minorId || null,
      nowIso(),
    ],
  );
  return { ok: true, id };
}

export async function checkCredentials(
  email: string,
  password: string,
): Promise<{ ok: true; id: string } | { ok: false }> {
  const row = await get<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE email = ?",
    [email.trim().toLowerCase()],
  );
  if (!row) return { ok: false };
  if (!verifyPassword(password, row.password_hash)) return { ok: false };
  return { ok: true, id: row.id };
}

export async function updateUserProfile(
  userId: string,
  patch: Partial<
    Pick<UserRow, "name" | "school" | "grad_year" | "major_id" | "major2_id" | "minor_id" | "advisor">
  >,
) {
  const cols: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`);
    params.push(v === undefined ? null : (v as string | number | null));
  }
  if (!cols.length) return;
  await run(`UPDATE users SET ${cols.join(", ")} WHERE id = ?`, [...params, userId]);
}

export async function sessionsReport() {
  return (await all<{ n: number }>("SELECT COUNT(*) n FROM sessions"))[0]?.n ?? 0;
}
