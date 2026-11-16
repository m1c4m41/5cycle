/**
 * Mint a valid session cookie for a local account and print it.
 * Reuses the exact same HMAC scheme as lib/session.ts so the running server
 * accepts it — needed to screenshot authenticated pages headlessly.
 *
 *   node scripts/mint-session.mjs [email]
 *
 * Prints "name=value". Development databases only.
 */
import "../scripts/register.mjs";
import crypto from "node:crypto";

const { get, run, newId } = await import("@/lib/db");

const email = process.argv[2] || "qa@5cycle.app";
const user = get("SELECT id FROM users WHERE email = ?", [email]);
if (!user) {
  console.error(`no such user: ${email}`);
  process.exit(1);
}

const secret =
  process.env.CYCLE_SESSION_SECRET ||
  // Must match the dev fallback in lib/session.ts, otherwise the server rejects it.
  "5cycle-dev-only-secret-change-me";

const token = crypto.randomBytes(24).toString("base64url");
const mac = crypto.createHmac("sha256", secret).update(token).digest("base64url");

run("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)", [
  token,
  user.id,
  Date.now() + 86400_000,
]);

process.stdout.write(`cycle_session=${token}.${mac}`);
