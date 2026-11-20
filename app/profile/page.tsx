import Link from "next/link";
import { redirect } from "next/navigation";
import { SCHOOLS, SCHOOL_BY_CODE } from "@/lib/constants";
import { catalogStats, currentTermId } from "@/lib/ingest";
import { getSet, listSets, progressForUser } from "@/lib/requirements";
import { enrolledSections } from "@/lib/schedule";
import { currentUser, isGuestUser } from "@/lib/session";
import { get } from "@/lib/db";
import { TrackSelect } from "@/components/TrackSelect";
import type { RequirementSet } from "@/lib/types";
import { schoolName, schoolShort, termLabel } from "@/lib/util";
import {
  cancelEmailChangeForm,
  changePasswordForm,
  setNotifyEmailForm,
  requestEmailChangeForm,
  verifyEmailChangeForm,
  clearSamplePlanForm,
  upgradeGuestForm,
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
  const tracks = await listSets({ kind: "track" });
  const campus = SCHOOL_BY_CODE[user.school] ? user.school : "";
  const majorGroups = byCampus(majors, campus);
  const minorGroups = byCampus(minors, campus);
  const majorName = user.major_id ? (await getSet(user.major_id))?.name : undefined;
  const major2Name = user.major2_id ? (await getSet(user.major2_id))?.name : undefined;
  const minorName = user.minor_id ? (await getSet(user.minor_id))?.name : undefined;
  const trackName = user.track_id ? (await getSet(user.track_id))?.name : undefined;

  const term = await currentTermId();
  const stats = await catalogStats();
  const terms = stats.terms.length
    ? stats.terms
    : [{ id: term, label: term ? termLabel(term) : "no terms synced", is_current: 1, synced_at: null }];

  const pendingEmail = isGuestUser(user)
    ? undefined
    : await get<{ new_email: string; expires_at: string }>(
        "SELECT new_email, expires_at FROM email_changes WHERE user_id = ?",
        [user.id],
      ).then((r) => (r && Date.parse(r.expires_at) > Date.now() ? r : undefined));
  const emailRow = isGuestUser(user)
    ? undefined
    : await get<{ v: string | null; n: number }>(
        "SELECT email_verified_at v, notify_email n FROM users WHERE id = ?",
        [user.id],
      );

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
          {trackName && (
            <span className="chip border-emerald-300 bg-emerald-50 text-emerald-800">{trackName}</span>
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

      {isGuestUser(user) && (
        <section id="save-account" className="card card-pad flex flex-col gap-3 border-brand-300 bg-brand-50/40">
          <h2 className="text-sm font-bold text-ink-900">Save your plan with an account</h2>
          <p className="text-xs leading-relaxed text-ink-600">
            You&rsquo;re using 5Cycle without an account, so your plan lives in this browser only —
            clearing cookies or switching devices would lose it. Add an email and password to keep
            everything you&rsquo;ve saved and open it anywhere.
          </p>
          <form action={upgradeGuestForm} method="post" className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="up-name">Your name</label>
              <input id="up-name" name="name" defaultValue={v("name", "")} className="input" autoComplete="name" required />
            </div>
            <div>
              <label className="label" htmlFor="up-email">Email</label>
              <input id="up-email" name="email" type="email" defaultValue={v("email", "")} className="input" autoComplete="email" required />
            </div>
            <div>
              <label className="label" htmlFor="up-pw">Password</label>
              <input id="up-pw" name="password" type="password" minLength={8} className="input" autoComplete="new-password" required />
            </div>
            <label className="flex items-start gap-2 text-xs text-ink-700 sm:col-span-3">
              <input type="checkbox" name="notifyEmail" className="mt-0.5" />
              <span>Email me when a seat opens in a class I&rsquo;m watching (you&rsquo;ll verify your email with a code first).</span>
            </label>
            <div className="sm:col-span-3">
              <button type="submit" className="btn-primary">Create account &amp; keep my plan</button>
            </div>
          </form>
        </section>
      )}

      <section className="card card-pad flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold text-ink-900">{isGuestUser(user) ? "Your profile" : "Sign-in"}</h2>
          <Link href="/requirements" className="link text-xs">
            View full checklist →
          </Link>
        </div>
        {!isGuestUser(user) && (
          <div>
            <label className="label" htmlFor="email">
              Email (<a href="#change-email" className="underline">change it below</a>)
            </label>
            <input id="email" value={user.email} className="input bg-ink-100 text-ink-600" readOnly />
          </div>
        )}
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

          <TrackSelect tracks={tracks} defaultValue={v("trackId", user.track_id ?? "")} />

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

      {/* ------------------------------- email -------------------------------- */}
      {!isGuestUser(user) && (
        <section id="change-email" className="card card-pad flex flex-col gap-3">
          <h2 className="text-sm font-bold text-ink-900">Email</h2>
          <p className="text-sm text-ink-600">
            Signed in as <span className="font-semibold text-ink-900">{user.email}</span>{" "}
            {emailRow?.v ? (
              <span className="chip border-emerald-300 bg-emerald-50 text-emerald-800">Verified</span>
            ) : (
              <span className="chip border-amber-300 bg-amber-50 text-amber-800">Not verified</span>
            )}
          </p>
          <form action={setNotifyEmailForm} method="post" className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" name="notifyEmail" defaultChecked={!!emailRow?.n} />
              Email me when a seat opens in a class I&rsquo;m watching
            </label>
            <button type="submit" className="btn-secondary">Save</button>
          </form>
          {!emailRow?.v && !pendingEmail && (
            <p className="text-xs text-amber-800">
              Seat-opening emails are only sent to a verified address. Enter your current email below
              with your password to get a code.
            </p>
          )}
          {pendingEmail ? (
            <form action={verifyEmailChangeForm} method="post" className="flex flex-col gap-3">
              <p className="text-xs text-ink-600">
                Enter the 6-digit code we sent to{" "}
                <span className="font-semibold text-ink-900">{pendingEmail.new_email}</span>. It expires
                in 10 minutes.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="label" htmlFor="code">Verification code</label>
                  <input id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                    autoComplete="one-time-code" className="input w-40 tracking-[0.3em]" required />
                </div>
                <button type="submit" className="btn-primary">Verify &amp; change email</button>
                <button type="submit" formAction={cancelEmailChangeForm} formNoValidate className="btn-secondary">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <form action={requestEmailChangeForm} method="post" className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="new-email">New email</label>
                <input id="new-email" name="email" type="email" defaultValue={v("newemail", "")}
                  className="input" autoComplete="email" required />
              </div>
              <div>
                <label className="label" htmlFor="email-pw">Password</label>
                <input id="email-pw" name="password" type="password" className="input"
                  autoComplete="current-password" required />
              </div>
              <div className="sm:col-span-2">
                <button type="submit" className="btn-primary">Send verification code</button>
              </div>
            </form>
          )}
        </section>
      )}

      {/* ------------------------------ password ------------------------------ */}
      {!isGuestUser(user) && (
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
      )}

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
