import Link from "next/link";
import { redirect } from "next/navigation";
import { getSection } from "@/lib/catalog";
import { SCHOOLS } from "@/lib/constants";
import { listSets } from "@/lib/requirements";
import { currentUser } from "@/lib/session";
import { safeNext } from "@/lib/server";
import { schoolShort, termLabel } from "@/lib/util";
import { guestStartForm } from "@/actions/form";
import type { RequirementSet } from "@/lib/types";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";

function byCampus(sets: RequirementSet[], campus: string) {
  const codes = [...new Set(sets.map((s) => s.school))].sort((a, b) => {
    if (a === campus) return -1;
    if (b === campus) return 1;
    return schoolShort(a).localeCompare(schoolShort(b));
  });
  return codes
    .map((code) => ({
      code,
      label: schoolShort(code),
      sets: sets.filter((s) => s.school === code).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.sets.length > 0);
}

/** Start without an account: only a campus is needed, plus the disclaimer tick. */
export default async function GuestPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  if (await currentUser()) redirect("/planner");

  const err = one(sp.err);
  const v = (k: string) => one(sp[`keep_${k}`]);
  const next = safeNext(one(sp.next), "/planner");
  const add = one(sp.add);
  const force = one(sp.force) === "1";
  const addSection = add ? await getSection(add) : undefined;

  const campuses = SCHOOLS.filter((s) => s.code !== "CG");
  const school = campuses.some((c) => c.code === v("school")) ? v("school") : "";
  const [majors, minors] = await Promise.all([listSets({ kind: "major" }), listSets({ kind: "minor" })]);
  const majorGroups = byCampus(majors, school);
  const minorGroups = byCampus(minors, school);

  return (
    <div className="mx-auto max-w-lg">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Continue as guest</h1>
        <p className="mt-2 text-sm text-ink-600">
          Pick your home campus and start planning. Add a major or minor if you like — it powers the
          requirements checklist.
        </p>
      </header>

      {err && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>
      )}

      {addSection && (
        <p className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
          <code className="font-mono">{addSection.code_string}</code> ({termLabel(addSection.term_id)}) will
          be added to your plan automatically.
        </p>
      )}

      <form action={guestStartForm} method="post" className="card card-pad flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        {add && <input type="hidden" name="add" value={add} />}
        {add && force && <input type="hidden" name="force" value="1" />}

        <div>
          <label className="label" htmlFor="school">
            Home campus <span className="font-normal normal-case text-red-600">(required)</span>
          </label>
          <select id="school" name="school" defaultValue={school} className="input" required>
            <option value="">Choose a campus…</option>
            {campuses.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.short})
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="majorId">
              Major <span className="font-normal normal-case text-ink-400">(optional)</span>
            </label>
            <select id="majorId" name="majorId" defaultValue={v("majorId")} className="input">
              <option value="">Undeclared / not listed</option>
              {majorGroups.map((g) => (
                <optgroup key={`m-${g.code}`} label={g.label}>
                  {g.sets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="minorId">
              Minor <span className="font-normal normal-case text-ink-400">(optional)</span>
            </label>
            <select id="minorId" name="minorId" defaultValue={v("minorId")} className="input">
              <option value="">No minor</option>
              {minorGroups.map((g) => (
                <optgroup key={`n-${g.code}`} label={g.label}>
                  {g.sets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
        <p className="-mt-2 text-xs text-ink-500">You can change all of this later on your profile.</p>

        <fieldset className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
          <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-amber-800">
            Before you continue
          </legend>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>Your data is stored locally, in this browser.</li>
            <li>It cannot synchronize to other devices or browsers.</li>
            <li>You may lose your data if you clear your browsing history or cookies.</li>
          </ul>
          <p className="mt-1.5 text-amber-900">
            Posting reviews needs an account. You can create one later from Profile and keep everything
            you&rsquo;ve saved.
          </p>
          <label className="mt-2 flex cursor-pointer items-start gap-2 font-medium">
            <input type="checkbox" name="ack" value="1" required className="mt-0.5 h-3.5 w-3.5 accent-brand-600" />
            <span>I understand</span>
          </label>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary">
            Start planning
          </button>
          <Link href="/signup" className="link text-sm">
            Create an account instead
          </Link>
          <Link href="/login" className="link text-sm">
            Sign in
          </Link>
        </div>
      </form>
    </div>
  );
}
