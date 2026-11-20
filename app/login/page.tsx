import Link from "next/link";
import { redirect } from "next/navigation";
import { getSection } from "@/lib/catalog";
import { currentUser } from "@/lib/session";
import { loginForm } from "@/actions/form";
import { termLabel } from "@/lib/util";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const err = one(sp.err);
  const ok = one(sp.ok);
  const email = one(sp.keep_email);

  // Only same-site paths are honoured as a post-login destination.
  const rawNext = one(sp.next);
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/planner";

  // A guest's "Add to plan" bounced here carrying the course: after sign-in
  // (or a fresh account) the add completes automatically.
  const add = one(sp.add);
  const force = one(sp.force) === "1";
  const addSection = add ? await getSection(add) : undefined;

  if (await currentUser()) redirect(next);

  const signupHref = (() => {
    const q = new URLSearchParams();
    q.set("next", next);
    if (add) q.set("add", add);
    if (force) q.set("force", "1");
    return `/signup?${q.toString()}`;
  })();

  return (
    <div className="mx-auto max-w-lg">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-ink-600">
          Your plan, checklist and saved sections are tied to this account.
        </p>
      </header>

      {err && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </p>
      )}

      {ok && (
        <p className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {ok}
        </p>
      )}

      {addSection && (
        <p className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
          When you&apos;re signed in,{" "}
          <code className="font-mono">{addSection.code_string}</code> (
          {termLabel(addSection.term_id)}) will be added to your plan automatically.
        </p>
      )}

      <form action={loginForm} method="post" className="card card-pad flex flex-col gap-4">
        <input type="hidden" id="next" name="next" defaultValue={next} />
        <label className="sr-only" htmlFor="next">
          Where to go after signing in
        </label>
        {add && <input type="hidden" name="add" value={add} />}
        {add && force && <input type="hidden" name="force" value="1" />}

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={email}
            className="input"
            autoComplete="email"
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
            autoComplete="current-password"
            required
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary">
            Sign in
          </button>
          <Link href={signupHref} className="link text-sm">
            Create an account
          </Link>
          <Link href="/forgot-password" className="link text-sm">
            Forgot password?
          </Link>
        </div>
      </form>
    </div>
  );
}
