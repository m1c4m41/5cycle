import Link from "next/link";
import { redirect } from "next/navigation";
import { getSection } from "@/lib/catalog";
import { SCHOOLS, SCHOOL_BY_CODE } from "@/lib/constants";
import { listSets } from "@/lib/requirements";
import { currentUser, isGuestUser } from "@/lib/session";
import { safeNext } from "@/lib/server";
import { schoolShort, termLabel } from "@/lib/util";
import { signupForm } from "@/actions/form";
import type { RequirementSet } from "@/lib/types";
import { TrackSelect } from "@/components/TrackSelect";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}

/** Group program sets by campus, putting the student's own campus first. */
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
      sets: sets
        .filter((s) => s.school === code)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.sets.length > 0);
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const me = await currentUser();
  if (me && !isGuestUser(me)) redirect("/planner");
  const guest = !!me; // a no-account visitor creating their account keeps their plan

  const err = one(sp.err);
  const v = (k: string) => one(sp[`keep_${k}`]);

  // A guest's "Add to plan" bounced through /login here: once the account
  // exists the pending add completes automatically.
  const next = safeNext(one(sp.next), "/planner");
  const add = one(sp.add);
  const force = one(sp.force) === "1";
  const addSection = add ? await getSection(add) : undefined;

  const campuses = SCHOOLS.filter((s) => s.code !== "CG");
  const school = campuses.some((c) => c.code === v("school")) ? v("school") : "";

  const majors = await listSets({ kind: "major" });
  const minors = await listSets({ kind: "minor" });
  const tracks = await listSets({ kind: "track" });
  const majorGroups = byCampus(majors, school);
  const minorGroups = byCampus(minors, school);
  const homeMajors = school ? majors.filter((m) => m.school === school).length : 0;
  const homeMinors = school ? minors.filter((m) => m.school === school).length : 0;

  return (
    <div className="mx-auto max-w-lg">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">
          {guest ? "Save your plan with an account" : "Plan your 5C year"}
        </h1>
        <p className="mt-2 text-sm text-ink-600">
          Tell 5Cycle your home campus and program and it builds a live checklist for your GE, major
          and minor. Then drag real sections onto a weekly timetable that already
          understands cross-registration, HMC&rsquo;s 3-credit scale and perm limits.
        </p>
      </header>

      {!guest && (
        <Link
          href={`/guest${add || next !== "/planner" ? `?${new URLSearchParams({ ...(next !== "/planner" ? { next } : {}), ...(add ? { add } : {}), ...(add && force ? { force: "1" } : {}) }).toString()}` : ""}`}
          className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-ink-200 bg-white px-4 py-3 text-sm hover:bg-ink-50"
        >
          <span>
            <span className="font-semibold text-ink-900">Continue as guest</span>
            <span className="block text-xs text-ink-500">No email or password — just pick your campus.</span>
          </span>
          <span aria-hidden className="text-lg text-ink-400">→</span>
        </Link>
      )}

      {err && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </p>
      )}

      {addSection && (
        <p className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
          After you create your account,{" "}
          <code className="font-mono">{addSection.code_string}</code> (
          {termLabel(addSection.term_id)}) will be added to your plan automatically.
        </p>
      )}

      <form action={signupForm} method="post" className="card card-pad flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        {add && <input type="hidden" name="add" value={add} />}
        {add && force && <input type="hidden" name="force" value="1" />}
        <div>
          <label className="label" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            name="name"
            defaultValue={v("name")}
            className="input"
            autoComplete="name"
            placeholder="Ada Torres"
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={v("email")}
            className="input"
            autoComplete="email"
            placeholder="atorres@cmc.edu"
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <p className="mt-1 text-xs text-ink-500">At least 8 characters.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="school">
              Home campus
            </label>
            <select id="school" name="school" defaultValue={school} className="input">
              <option value="">Choose a campus…</option>
              {campuses.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.short})
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-500">
              Leave it blank if your email is a school one — @pomona.edu, @cmc.edu,
              @scrippscollege.edu, @pitzer.edu or @harvey-mudd.edu picks your campus automatically.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="gradYear">
              Graduation year
            </label>
            <input
              id="gradYear"
              name="gradYear"
              type="number"
              inputMode="numeric"
              min={2024}
              max={2035}
              step={1}
              defaultValue={v("gradYear")}
              className="input"
              placeholder="2029"
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="majorId">
            Major
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
          <p className="mt-1 text-xs text-ink-500">
            {majors.length} major programs defined
            {school && SCHOOL_BY_CODE[school]
              ? ` · ${homeMajors} at ${schoolShort(school)}, listed first`
              : " · pick a campus and its own programs move to the top"}
            .
          </p>
        </div>

        <div>
          <label className="label" htmlFor="major2Id">
            Second major <span className="font-normal text-ink-400">(double major)</span>
          </label>
          <select id="major2Id" name="major2Id" defaultValue={v("major2Id")} className="input">
            <option value="">No second major</option>
            {majorGroups.map((g) => (
              <optgroup key={`m2-${g.code}`} label={g.label}>
                {g.sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-500">
            Double majoring? Pick the second program here — the checklist tracks both sets of
            requirements.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="minorId">
            Minor
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
          <p className="mt-1 text-xs text-ink-500">
            {minors.length} minor programs defined
            {school ? ` · ${homeMinors} at ${schoolShort(school)}` : ""}.
          </p>
        </div>

        <TrackSelect tracks={tracks} defaultValue={v("trackId")} optionalLabel />

        <div>
          <label className="label" htmlFor="advisor">
            Advisor <span className="font-normal normal-case text-ink-400">(optional)</span>
          </label>
          <input
            id="advisor"
            name="advisor"
            defaultValue={v("advisor")}
            className="input"
            placeholder="Dr. Medero"
          />
        </div>

        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" name="notifyEmail" className="mt-0.5" />
          <span>
            Email me when a seat opens in a class I&rsquo;m watching.
            <span className="block text-xs text-ink-500">
              We&rsquo;ll ask you to verify your email with a code first. You can turn this off any time on your profile.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary">
            Create account
          </button>
          <Link href="/login" className="link text-sm">
            Already have an account?
          </Link>
        </div>

        <p className="text-xs text-ink-500">
          Your checklist is seeded from three requirement sets: your home campus GE set, your major,
          and your minor. You can change all of them later on your profile.
        </p>
      </form>

      <p className="mt-4 text-xs leading-relaxed text-ink-500">
        Requirement definitions in 5Cycle are editable working defaults assembled from registrar
        course-area codes and department pages. They are a planning aid, not an official degree
        audit — confirm your progress with your registrar and advisor before you graduate.
      </p>
    </div>
  );
}
