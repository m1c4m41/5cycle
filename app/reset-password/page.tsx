import Link from "next/link";
import { redirect } from "next/navigation";
import { resetPasswordForm } from "@/actions/password-reset";

export const dynamic = "force-dynamic";
type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const email = one(sp.email);
  if (!email) redirect("/forgot-password");
  const err = one(sp.err);
  const ok = one(sp.ok);
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Choose a new password</h1>
      <p className="mt-2 text-sm text-ink-600">
        Enter the code emailed to <span className="font-semibold text-ink-900">{email}</span>, then your new password.
      </p>
      {ok && <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}
      {err && <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      <form action={resetPasswordForm} method="post" className="card card-pad mt-4 flex flex-col gap-3">
        <input type="hidden" name="email" value={email} />
        <div>
          <label className="label" htmlFor="code">Verification code</label>
          <input id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            autoComplete="one-time-code" className="input w-40 tracking-[0.3em]" required autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="next">New password</label>
          <input id="next" name="next" type="password" minLength={8} className="input" autoComplete="new-password" required />
          <p className="mt-1 text-xs text-ink-500">At least 8 characters.</p>
        </div>
        <div>
          <label className="label" htmlFor="confirm">Confirm password</label>
          <input id="confirm" name="confirm" type="password" minLength={8} className="input" autoComplete="new-password" required />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary">Change password</button>
          <Link href="/forgot-password" className="link text-sm">Send a new code</Link>
        </div>
      </form>
    </div>
  );
}
