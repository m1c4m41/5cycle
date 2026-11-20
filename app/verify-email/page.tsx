import Link from "next/link";
import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import { currentUser, isGuestUser } from "@/lib/session";
import { safeNext } from "@/lib/server";
import { resendSignupCodeForm, verifySignupEmailForm } from "@/actions/form";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await currentUser();
  if (!user || isGuestUser(user)) redirect("/login");
  const next = safeNext(one(sp.next), "/planner");
  const row = await get<{ v: string | null }>("SELECT email_verified_at v FROM users WHERE id = ?", [user.id]);
  if (row?.v) redirect(next);
  const err = one(sp.err);
  const ok = one(sp.ok);

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Verify your email</h1>
      <p className="mt-2 text-sm text-ink-600">
        We sent a 6-digit code to <span className="font-semibold text-ink-900">{user.email}</span>.
        Enter it to confirm the address (seat-opening emails are only sent to verified addresses).
      </p>
      {err && <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      {ok && <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}
      <form action={verifySignupEmailForm} method="post" className="card card-pad mt-4 flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <div>
          <label className="label" htmlFor="code">Verification code</label>
          <input id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            autoComplete="one-time-code" className="input w-40 tracking-[0.3em]" required autoFocus />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary">Verify</button>
          <button type="submit" formAction={resendSignupCodeForm} formNoValidate className="btn-secondary">
            Send a new code
          </button>
        </div>
      </form>
      <p className="mt-4 text-sm">
        <Link href={next} className="link">Skip for now</Link>
        <span className="text-ink-500"> — you can verify later from your profile.</span>
      </p>
    </div>
  );
}
