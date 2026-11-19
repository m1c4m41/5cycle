import Link from "next/link";
import { currentUser, isGuestUser } from "@/lib/session";
import { GuestKeepAlive } from "@/components/GuestKeepAlive";
import { logoutAction } from "@/actions/auth";
import { schoolShort } from "@/lib/util";

const LINKS = [
  { href: "/catalog", label: "Catalog" },
  { href: "/planner", label: "Planner" },
  { href: "/requirements", label: "Checklist" },
  { href: "/professors", label: "Professors" },
];

export async function Nav() {
  const user = await currentUser();
  return (
    <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link
          href="/"
          aria-label="5Cycle home"
          className="flex items-center gap-1.5 font-bold tracking-tight text-ink-900"
        >
          <img src="/logo-5.png" alt="" className="h-8 w-auto" />
          <span aria-hidden="true" className="text-lg text-black">
            ycle
          </span>
        </Link>

        <nav className="flex flex-wrap items-center gap-1 text-sm">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg px-2.5 py-1.5 font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-sm">
          {user ? (
            <>
              <span className="hidden text-ink-500 sm:inline">
                {isGuestUser(user) ? "No account" : user.name}
                <span className="ml-1.5 chip border-ink-300 bg-ink-100 text-ink-600">
                  {schoolShort(user.school)}
                </span>
              </span>
              {isGuestUser(user) ? (
                <>
                  <GuestKeepAlive />
                  <Link href="/profile#save-account" className="btn-primary" title="Keep your plan on any device">
                    Save your plan
                  </Link>
                  <Link href="/profile" className="btn-ghost">
                    Profile
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/profile" className="btn-ghost">
                    Account
                  </Link>
                  <form action={logoutAction} className="inline">
                    <button type="submit" className="btn-ghost">
                      Sign out
                    </button>
                  </form>
                </>
              )}
            </>
          ) : (
            <>
              <Link href="/login" className="btn-ghost">
                Sign in
              </Link>
              <Link href="/signup" className="btn-primary">
                Create account
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
