/**
 * Shared helpers for Server Actions.
 *
 * Note on architecture: every mutation in this app is a Server Action rather
 * than a browser fetch to /api/*. That keeps the client bundle tiny (forms work
 * even with JavaScript disabled) and means the UI never has to know where the
 * API is hosted. The /api/* routes still exist for programmatic access and
 * for other frontends, but nothing in app/ depends on them.
 */
import crypto from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, Unauthorized } from "./session";
import type { UserRow } from "./types";

export type ActionState = { ok: boolean; error?: string; notice?: string } | null;

export const IDLE: ActionState = null;

/** All the pages that render schedule or requirement state. */
export const SCHEDULE_PATHS = ["/planner", "/catalog", "/requirements", "/section"];

export function revalidateSchedule() {
  for (const p of SCHEDULE_PATHS) revalidatePath(p, "layout");
}

export async function userOrRedirect(to = "/login"): Promise<UserRow> {
  try {
    return await requireUser();
  } catch {
    redirect(to);
  }
}

export function formStr(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export function formNum(fd: FormData, key: string): number | null {
  const raw = formStr(fd, key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fail-closed admin gate (shared by Server Actions and /api/sync).
 *
 * True only when CYCLE_ADMIN_TOKEN is configured AND the presented value
 * matches it (constant-time compare). With no token configured, nobody is
 * authorized — a public deployment that forgets the env var gets a locked
 * console, not an open one.
 */
export function isAdminToken(provided: string): boolean {
  const expected = process.env.CYCLE_ADMIN_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const ACTIONS_ENABLED =
  process.env.CYCLE_DISABLE_SERVER_ACTIONS !== "1";

/** Guard used at the top of every action so the flag is honoured everywhere. */
export function assertActionsEnabled() {
  if (!ACTIONS_ENABLED) {
    throw new Error(
      "Server Actions are disabled (CYCLE_DISABLE_SERVER_ACTIONS=1). Unset it to enable writes.",
    );
  }
}

export function isUnauthorized(err: unknown): err is Unauthorized {
  return err instanceof Unauthorized;
}

/**
 * Validate a `?next=` round-trip: only same-site paths are honoured, so a
 * crafted value can't turn into an open redirect.
 */
export function safeNext(raw: string, fallback: string): string {
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}

/** Send ?notice= / ?err= back to a page without throwing away the form. */
export function redirectToWithError(path: string, error: string): never {
  const url = new URL(path, "http://internal");
  url.searchParams.set("err", error);
  redirect(url.pathname + url.search);
}
