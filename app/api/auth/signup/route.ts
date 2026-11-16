import { createUser, startSession } from "@/lib/session";
import { requirementsLoaded, loadRequirementFiles } from "@/lib/requirements";
import { jsonResponse } from "@/lib/util";
import { SCHOOL_BY_CODE } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!requirementsLoaded()) loadRequirementFiles();

  let body: Record<string, string | number | null | undefined>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Expected a JSON body." }, { status: 400 });
  }

  const school = String(body.school ?? "").toUpperCase();
  if (!SCHOOL_BY_CODE[school]) {
    return jsonResponse({ error: "Pick one of the five Claremont Colleges." }, { status: 400 });
  }

  const res = createUser({
    name: String(body.name ?? ""),
    email: String(body.email ?? ""),
    password: String(body.password ?? ""),
    school,
    gradYear: body.gradYear ? Number(body.gradYear) : null,
    majorId: body.majorId ? String(body.majorId) : null,
    minorId: body.minorId ? String(body.minorId) : null,
  });

  if (!res.ok) return jsonResponse({ error: res.error }, { status: 400 });
  await startSession(res.id);
  return jsonResponse({ ok: true, userId: res.id }, { status: 201 });
}
