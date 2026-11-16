import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { currentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: {
    default: "5Cycle — 5C Academic Planner",
    template: "%s · 5Cycle",
  },
  description:
    "Browse the Claremont Colleges course catalog, plan your term on a weekly timetable, track major, minor and GE checklists, get cross-registration perm links, and rate professors.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en" data-school={user?.school ? user.school.toLowerCase() : undefined}>
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</main>
        <footer className="mt-12 border-t border-ink-200 bg-white">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs text-ink-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>
              <strong className="text-ink-700">5Cycle</strong> — student planner for the Claremont
              Colleges. Course data auto-updates as the registrar publishes new terms.
            </p>
            <p>Requirement checklists are <em>advising aids</em> — always confirm with your registrar.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
