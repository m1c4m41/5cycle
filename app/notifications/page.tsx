import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isGuestUser } from "@/lib/session";
import { listNotifications } from "@/lib/notify";
import { DesktopToggle } from "@/components/DesktopToggle";
import { SoundToggle } from "@/components/SoundToggle";
import { LocalTime } from "@/components/LocalTime";
import { markAllReadAction } from "@/actions/notifications";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=%2Fnotifications");
  const items = await listNotifications(user.id);
  const unread = items.filter((n) => !n.read_at).length;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        {unread > 0 && (
          <form action={markAllReadAction}>
            <button type="submit" className="btn-secondary text-xs">
              Mark all read
            </button>
          </form>
        )}
      </header>

      <p className="text-sm text-ink-600">
        Tick <strong>Notify me when a spot opens</strong> on a full class in your planner and you&rsquo;ll
        get an alert here every time a seat opens, until you mark the class Registered or Perm requested (or untick it){isGuestUser(user) ? "" : " (and an email, when email alerts are switched on)"}.
        Classes that need a perm aren&rsquo;t covered — those seats are approved by the instructor.
        {isGuestUser(user) && (
          <>
            {" "}
            Without an account, alerts only show up here;{" "}
            <Link href="/profile#save-account" className="link">
              create an account
            </Link>{" "}
            to be emailed too.
          </>
        )}
      </p>

      <div className="card card-pad">
        <div className="space-y-2">
          <SoundToggle />
          <DesktopToggle />
        </div>
        <p className="mt-2 text-xs text-ink-500">
          The chime and the pop-up work while 5Cycle is open in a browser tab (checked about every 30
          seconds) — keep a tab open in the background. Your browser may stay silent until you&rsquo;ve
          clicked on the page once, and each browser or device has its own settings.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="card card-pad text-sm text-ink-600">No alerts yet.</div>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n.id}
              className={`card card-pad ${n.read_at ? "" : "border-brand-300 bg-brand-50/40"}`}
            >
              <p className="text-sm font-semibold text-ink-900">
                {n.read_at ? "" : "● "}
                {n.title}
              </p>
              <p className="mt-0.5 text-sm text-ink-700">{n.body}</p>
              <p className="mt-1 text-xs text-ink-400">
                <LocalTime iso={n.created_at} />
                {n.section_id && (
                  <>
                    {" · "}
                    <Link href={`/section/${encodeURIComponent(n.section_id)}`} className="link">
                      View class
                    </Link>
                    {" · "}
                    <Link href="/planner" className="link">
                      Planner
                    </Link>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
