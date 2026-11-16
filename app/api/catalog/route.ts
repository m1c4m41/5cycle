import { searchSections, facets } from "@/lib/catalog";
import { currentTermId } from "@/lib/ingest";
import { jsonResponse } from "@/lib/util";
import type { CatalogQuery } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function list(sp: URLSearchParams, key: string): string[] | undefined {
  const v = sp.getAll(key).flatMap((x) => x.split(",")).map((s) => s.trim()).filter(Boolean);
  return v.length ? Array.from(new Set(v)) : undefined;
}

function num(sp: URLSearchParams, key: string): number | undefined {
  const v = sp.get(key);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const q: CatalogQuery = {
    q: sp.get("q") ?? undefined,
    term: sp.get("term") ?? currentTermId(),
    schools: list(sp, "school"),
    departments: list(sp, "dept"),
    areas: list(sp, "area"),
    instructor: sp.get("instructor") ?? undefined,
    minCredits: num(sp, "minCredits"),
    maxCredits: num(sp, "maxCredits"),
    openOnly: sp.get("open") === "1",
    permOnly: sp.get("perm") === "1",
    notAtSchool: sp.get("notAtSchool") ?? undefined,
    limit: num(sp, "limit") ?? 25,
    offset: num(sp, "offset") ?? 0,
    sort: (sp.get("sort") as CatalogQuery["sort"]) ?? "code",
  };

  const { rows, total } = searchSections(q);
  return jsonResponse({
    term: q.term,
    total,
    offset: q.offset,
    limit: q.limit,
    results: rows,
    facets: facets(q.term),
  });
}
