import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/session";
import { all } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Light poll for the bell: unread count and the newest unread alert. */
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ unread: 0, latestId: null }, { status: 401 });
  const rows = await all<{ id: string; title: string; body: string }>(
    "SELECT id, title, body FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [userId],
  );
  const n = await all<{ n: number }>(
    "SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL",
    [userId],
  );
  return NextResponse.json(
    { unread: Number(n[0]?.n ?? 0), latestId: rows[0]?.id ?? null, latestTitle: rows[0]?.title ?? null, latestBody: rows[0]?.body ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
