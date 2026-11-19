import { NextResponse, type NextRequest } from "next/server";
import { GUEST_COOKIE_AGE, GUEST_FLAG_COOKIE, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * No-account visitors keep their profile "forever": each visit calls this to
 * re-issue the session cookie with a fresh ~400-day lifetime (the most a
 * browser allows), so it never runs out while they keep using the site.
 * Only browsers carrying the guest marker are touched; it reads no database.
 */
export async function POST(req: NextRequest) {
  const res = new NextResponse(null, { status: 204 });
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  if (session && req.cookies.get(GUEST_FLAG_COOKIE)?.value === "1") {
    const opts = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: GUEST_COOKIE_AGE,
    };
    res.cookies.set(SESSION_COOKIE, session, opts);
    res.cookies.set(GUEST_FLAG_COOKIE, "1", opts);
  }
  return res;
}
