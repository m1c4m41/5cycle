/**
 * Password hashing, isolated from the request layer.
 *
 * scrypt is built into node:crypto, so this file is importable from CLI scripts
 * and tests. lib/session.ts (which touches next/headers) re-exports it.
 */
import crypto from "node:crypto";

/** `scrypt$<saltHex>$<keyHex>` — self-describing so the format can be migrated. */
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw.normalize("NFKC"), salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = crypto.scryptSync(
    pw.normalize("NFKC"),
    Buffer.from(saltHex, "hex"),
    expected.length,
  );
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
