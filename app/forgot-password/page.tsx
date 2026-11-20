import Link from "next/link";
import { requestResetForm } from "@/actions/password-reset";

export const dynamic = "force-dynamic";
type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const err = one(sp.err);
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight">Forgot your password?</h1>
      <p className="mt-2 text-sm text-ink-600">
        Enter your account email and we&rsquo;ll send a 6-digit code so you can choose a new password.
      </p>
      {err && <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      <form action={requestResetForm} method="post" className="card card-pad mt-4 flex flex-col gap-3">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" defaultValue={one(sp.keep_email)} className="input" autoComplete="email" required />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary">Send code</button>
          <Link href="/login" className="link text-sm">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}
