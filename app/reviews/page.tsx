import Link from "next/link";
import { allReviews } from "@/lib/read";
import { currentUser } from "@/lib/session";
import { ReviewCard } from "@/components/ReviewCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "All reviews" };

const PAGE_SIZE = 25;

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.toString().trim() ?? "";

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await currentUser();
  const mineOnly = Boolean(user) && one(sp.mine) === "1";
  const page = Math.max(1, Number(one(sp.page)) || 1);

  const { rows, total, professors } = await allReviews({
    userId: user?.id,
    mineOnly,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { mine: mineOnly ? "1" : undefined, page: undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return `/reviews${s ? `?${s}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">
          {mineOnly ? "Your reviews" : "All reviews"}
        </h1>
        <p className="text-sm text-ink-600">
          <strong className="tabular-nums text-ink-800">{total.toLocaleString()}</strong>{" "}
          review{total === 1 ? "" : "s"} of{" "}
          <strong className="tabular-nums text-ink-800">{professors.toLocaleString()}</strong>{" "}
          professor{professors === 1 ? "" : "s"}, newest first. Reviews are anonymous and stay up
          until their author deletes them or their account.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
          <Link
            href={href({ mine: undefined })}
            className={mineOnly ? "btn-secondary" : "btn-primary"}
          >
            Everyone
          </Link>
          {user ? (
            <Link href={href({ mine: "1" })} className={mineOnly ? "btn-primary" : "btn-secondary"}>
              Mine
            </Link>
          ) : (
            <Link href="/login?next=/reviews" className="link text-xs">
              Sign in to see your own
            </Link>
          )}
          <Link href="/professors" className="link ml-auto text-xs">
            Browse professors →
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="card card-pad text-center">
          <p className="font-semibold text-ink-800">
            {mineOnly ? "You haven't written a review yet." : "No reviews yet."}
          </p>
          <p className="mt-1 text-sm text-ink-600">
            Open a professor&apos;s page and use “Write one” — it takes a minute.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <ReviewCard r={r} mine={r.mine} professor={{ id: r.professor_id, name: r.professor_name }} />
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Pagination">
          <span className="text-xs text-ink-500">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{" "}
            {total.toLocaleString()}
          </span>
          <div className="flex gap-1">
            {page > 1 && (
              <Link href={href({ page: String(page - 1) })} className="btn-secondary">
                ← Newer
              </Link>
            )}
            {page < pages && (
              <Link href={href({ page: String(page + 1) })} className="btn-secondary">
                Older →
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
