/**
 * Minimal, dependency-free account system: scrypt password hashing + HMAC
 * signed session cookie. Swap for the campus SAML/OIDC provider later — the
 * only surface the app depends on is `currentUser()` / `requireUser()`.
 */
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { all, get, newId, nowIso, run } from "./db";
import { hashPassword, verifyPassword } from "./password";
import type { UserRow } from "./types";

// Re-exported so callers (and the CLI, which must not import next/headers) can
// pick the hashing helpers up from either place.
export { hashPassword, verifyPassword };

export const SESSION_COOKIE = "cycle_session";
const COOKIE = SESSION_COOKIE;
const DAY = 86400_000;
const SESSION_TTL = 30 * DAY;
/** No-account visitors stay signed in on their browser indefinitely: the server
 *  session never really expires, and middleware.ts re-ups the cookie on every
 *  visit (browsers cap one cookie's lifetime at ~400 days, so it must be renewed). */
const GUEST_TTL = 100 * 365 * DAY;
export const GUEST_FLAG_COOKIE = "cycle_guest";
export const GUEST_COOKIE_AGE = 400 * 86400; // seconds — the browser maximum

/** "Guest" profiles are real rows under a placeholder address; they upgrade in place. */
export const GUEST_DOMAIN = "guest.local";
export const isGuestUser = (u: { email: string } | null | undefined): boolean =>
  !!u && u.email.endsWith(`@${GUEST_DOMAIN}`);

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

export async function startSession(
  userId: string,
  ttl: number = SESSION_TTL,
  cookieAgeSeconds: number = ttl / 1000,
): Promise<void> {
  const { cookie, stored } = makeToken();
  // Store only the random half. The signature is derived from it, so anything
  // that can read the table still cannot mint a cookie without the HMAC secret
  // — and, critically, the lookup below asks for exactly this value. Storing
  // the signed string meant the query never matched and sessions silently
  // failed for every user.
  await run("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)", [
    stored,
    userId,
    Date.now() + ttl,
  ]);
  const jar = await cookies();
  jar.set(COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: cookieAgeSeconds,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(GUEST_FLAG_COOKIE);
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

/** Uncached lookup — use after/around mutations (requireUser does). */
async function loadCurrentUser(): Promise<UserRow | null> {
  const id = await currentUserId();
  if (!id) return null;
  return (
    (await get<UserRow>(
      `SELECT id, email, name, school, grad_year, major_id, major2_id, minor_id, track_id, advisor
       FROM users WHERE id = ?`,
      [id],
    )) ?? null
  );
}

// cache(): the app layout AND the page each call currentUser() per render;
// the per-request memo collapses that to a single session lookup. Server
// actions go through requireUser() (uncached) so a mutation followed by the
// re-render in the same request never sees a pre-mutation row.
export const currentUser: () => Promise<UserRow | null> = cache(loadCurrentUser);

export class Unauthorized extends Error {
  constructor() {
    super("Not signed in");
  }
}

export async function requireUser(): Promise<UserRow> {
  const u = await loadCurrentUser();
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
  trackId?: string | null;
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
    `INSERT INTO users(id, email, name, password_hash, school, grad_year, major_id, major2_id, minor_id, track_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
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
      input.trackId || null,
      nowIso(),
    ],
  );
  return { ok: true, id };
}

/** A profile with no email or password, held by this browser's session cookie. */
export async function createGuest(input: Omit<SignupInput, "email" | "password" | "name"> & { name?: string }): Promise<string> {
  const id = newId("usr-");
  await run(
    `INSERT INTO users(id, email, name, password_hash, school, grad_year, major_id, major2_id, minor_id, track_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      `${id}@${GUEST_DOMAIN}`,
      input.name?.trim() || "Guest",
      hashPassword(crypto.randomBytes(24).toString("base64url")), // never usable to sign in
      input.school,
      input.gradYear ?? null,
      input.majorId || null,
      input.major2Id || null,
      input.minorId || null,
      input.trackId || null,
      nowIso(),
    ],
  );
  return id;
}

export async function startGuestSession(userId: string): Promise<void> {
  await startSession(userId, GUEST_TTL, GUEST_COOKIE_AGE);
  // A marker the middleware can read (it can't query the database) to know
  // this browser holds a no-account profile whose cookie should be renewed.
  const jar = await cookies();
  jar.set(GUEST_FLAG_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_COOKIE_AGE,
  });
}

/** Turn a guest profile into a real account, keeping everything saved so far. */
export async function upgradeGuest(
  userId: string,
  input: { name: string; email: string; password: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (email.endsWith(`@${GUEST_DOMAIN}`)) return { ok: false, error: "Enter a valid email address." };
  if (input.password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (await get("SELECT id FROM users WHERE email = ? AND id <> ?", [email, userId]))
    return { ok: false, error: "An account with that email already exists. Sign in instead." };
  await run("UPDATE users SET email = ?, name = ?, password_hash = ? WHERE id = ?", [
    email,
    input.name.trim(),
    hashPassword(input.password),
    userId,
  ]);
  return { ok: true };
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
    Pick<UserRow, "name" | "school" | "grad_year" | "major_id" | "major2_id" | "minor_id" | "track_id" | "advisor">
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
