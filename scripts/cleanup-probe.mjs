/**
 * Remove the throwaway accounts created by manual API probing.
 * Leaves qa@5cycle.app and any real signup alone.
 *   node scripts/cleanup-probe.mjs
 */
import "../scripts/register.mjs";

const { all, run } = await import("@/lib/db");

const rows = await all(
  "SELECT id, email FROM users WHERE email LIKE 'probe%@5cycle.app' OR email LIKE 'smoke%@5cycle.app'",
);
if (!rows.length) {
  console.log("no probe/smoke accounts to remove");
} else {
  for (const u of rows) {
    await run("DELETE FROM enrollments WHERE user_id = ?", [u.id]);
    await run("DELETE FROM reviews WHERE user_id = ?", [u.id]);
    await run("DELETE FROM sessions WHERE user_id = ?", [u.id]);
    await run("DELETE FROM users WHERE id = ?", [u.id]);
    console.log(`removed ${u.email}`);
  }
}
const left = await all("SELECT email, school FROM users ORDER BY email");
console.log(`\nremaining accounts (${left.length}):`);
left.forEach((u) => console.log(`  ${u.email}  [${u.school}]`));
