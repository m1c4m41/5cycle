import { checkCredentials, endSession, startSession } from "@/lib/session";
import { jsonResponse } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (!body.email || !body.password) {
    return jsonResponse({ error: "Email and password are required." }, { status: 400 });
  }
  const res = await checkCredentials(body.email, body.password);
  if (!res.ok) {
    // Same message for unknown email and wrong password.
    return jsonResponse({ error: "Those credentials don't match an account." }, { status: 401 });
  }
  await startSession(res.id);
  return jsonResponse({ ok: true });
}

export async function DELETE() {
  await endSession();
  return jsonResponse({ ok: true });
}
