import Link from "next/link";
import { redirect } from "next/navigation";
import { SCHOOLS, SCHOOL_BY_CODE } from "@/lib/constants";
import { catalogStats, currentTermId } from "@/lib/ingest";
import { getSet, listSets, progressForUser } from "@/lib/requirements";
import { enrolledSections } from "@/lib/schedule";
import { currentUser } from "@/lib/session";
import type { RequirementSet } from "@/lib/types";
import { schoolName, schoolShort, termLabel } from "@/lib/util";
import {
  changePasswordForm,
  clearSamplePlanForm,
  seedSamplePlanForm,
  updateProfileForm,
  wipeAccountForm,
} from "@/actions/form";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}

/** Group program sets by campus, home campus first. */
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

export default async function ProfilePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/login?next=%2Fprofile");

  const err = one(sp.err);
  const ok = one(sp.ok);
  const v = (k: string, fallback: string) => one(sp[`keep_${k}`]) || fallback;

  const majors = await listSets({ kind: "major" });
  const minors = await listSets({ kind: "minor" });
  const campus = SCHOOL_BY_CODE[user.school] ? user.school : "";
  const majorGroups = byCampus(majors, campus);
  const minorGroups = byCampus(minors, campus);
  const majorName = user.major_id ? (await getSet(user.major_id))?.name : undefined;
  const major2Name = user.major2_id ? (await getSet(user.major2_id))?.name : undefined;
  const minorName = user.minor_id ? (await getSet(user.minor_id))?.name : undefined;

  const term = await currentTermId();
  const stats = await catalogStats();
  const terms = stats.terms.length
    ? stats.terms
    : [{ id: term, label: term ? termLabel(term) : "no terms synced", is_current: 1, synced_at: null }];

  const planned = await enrolledSections(user.id);
  const progress = await progressForUser(user, planned);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{user.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-600">
          <span>{schoolName(user.school)}</span>
          <span className="chip border-ink-300 bg-ink-100 text-ink-600">
            {schoolShort(user.school)}
          </span>
          {user.grad_year ? (
            <span className="chip border-ink-200 bg-white text-ink-500">
              Class of {user.grad_year}
            </span>
          ) : null}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {majorName ? (
            <span className="chip border-brand-300 bg-white text-brand-700">
              {majorName}
              {major2Name ? " + " : ""}
            </span>
          ) : (
            <span className="chip border-ink-200 bg-white text-ink-500">No major selected</span>
          )}
          {major2Name && (
            <span
              className="chip border-brand-300 bg-white text-brand-700"
              title="Double major — tracked in the checklist with its own requirements"
            >
              + {major2Name}
            </span>
          )}
          {minorName ? (
            <span className="chip border-ink-300 bg-ink-100 text-ink-600">{minorName}</span>
          ) : (
            <span className="chip border-ink-200 bg-white text-ink-500">No minor</span>
          )}
        </div>
      </header>

      {err && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </p>
      )}
      {ok && (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {ok}
        </p>
      )}

      <section className="card card-pad flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold text-ink-900">Sign-in</h2>
          <Link href="/requirements" className="link text-xs">
            View full checklist →
          </Link>
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email (contact your registrar to change it)
          </label>
          <input id="email" value={user.email} className="input bg-ink-100 text-ink-600" readOnly />
        </div>
        {progress.length > 0 && (
          <ul className="grid gap-1 text-xs text-ink-600">
            {progress.map((p) => (
              <li key={p.set.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {p.set.name}{" "}
                  <span className="text-ink-400">
                    ({p.satisfiedGroups}/{p.totalGroups} groups)
                  </span>
                </span>
                <span className="font-semibold text-ink-800">{p.percent}%</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-500">
          {planned.length} planned course{planned.length === 1 ? "" : "s"} across{" "}
          {stats.sections.toLocaleString()} catalog sections.
        </p>
      </section>

      {/* ------------------------------ academics ----------------------------- */}
      <section className="card card-pad flex flex-col gap-4">
        <h2 className="text-sm font-bold text-ink-900">Academics</h2>
        <form action={updateProfileForm} method="post" className="flex flex-col gap-4">
          <div>
            <label className="label" htmlFor="name">
              Display name
            </label>
            <input
              id="name"
              name="name"
              defaultValue={v("name", user.name)}
              className="input"
              autoComplete="name"
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="school">
                Home campus
              </label>
              <select
                id="school"
                name="school"
                defaultValue={v("school", user.school)}
                className="input"
                required
              >
                {SCHOOLS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} ({s.short})
                  </option>
                ))}
              </select>
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
                defaultValue={v("gradYear", user.grad_year ? String(user.grad_year) : "")}
                className="input"
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="majorId">
              Major
            </label>
            <select id="majorId" name="majorId" defaultValue={v("majorId", user.major_id ?? "")} className="input">
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
              {campus ? ` · ${majors.filter((m) => m.school === campus).length} at ${schoolShort(campus)}, listed first` : ""}
              .
            </p>
          </div>

          <div>
            <label className="label" htmlFor="major2Id">
              Second major (double major)
            </label>
            <select
              id="major2Id"
              name="major2Id"
              defaultValue={v("major2Id", user.major2_id ?? "")}
              className="input"
            >
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
              Double majoring? Pick the second program here and the checklist tracks both sets of
              requirements — one box per program, each with its own progress.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="minorId">
              Minor
            </label>
            <select id="minorId" name="minorId" defaultValue={v("minorId", user.minor_id ?? "")} className="input">
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
              {campus ? ` · ${minors.filter((m) => m.school === campus).length} at ${schoolShort(campus)}` : ""}
              .
            </p>
          </div>

          <div>
            <label className="label" htmlFor="advisor">
              Advisor
            </label>
            <input
              id="advisor"
              name="advisor"
              defaultValue={v("advisor", user.advisor ?? "")}
              className="input"
              placeholder="Dr. Medero"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn-primary">
              Save academics
            </button>
            <Link href="/requirements" className="link text-sm">
              See what this leaves to fill
            </Link>
          </div>
        </form>
      </section>

      {/* --------------------------- sample plan tools ------------------------- */}
      <section className="card card-pad flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-bold text-ink-900">Fill my plan with sample courses</h2>
          <p className="mt-1 text-sm text-ink-600">
            The requirement engine picks open, non-conflicting sections that advance your GE, major
            and minor slots, so the checklist visibly moves. Added courses are tagged as sample and
            can be removed again.
          </p>
        </div>

        <form action={seedSamplePlanForm} method="post" className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="term">
                Term to fill
              </label>
              <select id="term" name="term" defaultValue={v("term", term)} className="input">
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label || termLabel(t.id)} ({t.id})
                    {t.id === term ? " — current" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="courses">
                Courses (1–8)
              </label>
              <input
                id="courses"
                name="courses"
                type="number"
                inputMode="numeric"
                min={1}
                max={8}
                step={1}
                defaultValue={v("courses", "5")}
                className="input"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-secondary">
              Add suggested courses
            </button>
            <span className="text-xs text-ink-500">
              Current term: <code className="kbd">{term || "none synced"}</code>
            </span>
          </div>
        </form>

        <form action={clearSamplePlanForm} method="post">
          <button type="submit" className="btn-ghost">
            Remove sample courses from my plan
          </button>
        </form>
      </section>

      {/* ------------------------------ password ------------------------------ */}
      <section className="card card-pad flex flex-col gap-4">
        <h2 className="text-sm font-bold text-ink-900">Change password</h2>
        <form action={changePasswordForm} method="post" className="flex flex-col gap-4">
          <div>
            <label className="label" htmlFor="current">
              Current password
            </label>
            <input
              id="current"
              name="current"
              type="password"
              className="input"
              autoComplete="current-password"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="next">
              New password
            </label>
            <input
              id="next"
              name="next"
              type="password"
              className="input"
              autoComplete="new-password"
              minLength={8}
              required
            />
            <p className="mt-1 text-xs text-ink-500">At least 8 characters.</p>
          </div>
          <button type="submit" className="btn-secondary self-start">
            Update password
          </button>
        </form>
      </section>

      {/* ----------------------------- danger zone ---------------------------- */}
      <section className="card card-pad flex flex-col gap-3 border-red-200">
        <h2 className="text-sm font-bold text-red-800">Danger zone</h2>
        <p className="text-sm text-ink-600">
          Erasing your account deletes every planned course, every review you wrote and every
          session. There is no undo and no export yet.
        </p>
        <form action={wipeAccountForm} method="post" className="flex flex-col gap-3">
          <div>
            <label className="label" htmlFor="confirm">
              Type DELETE to confirm
            </label>
            <input
              id="confirm"
              name="confirm"
              className="input"
              placeholder="DELETE"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
          <button type="submit" className="btn-danger self-start">
            Erase my account
          </button>
        </form>
      </section>
    </div>
  );
}
