/** Clinical / volunteer / shadowing hours log for the checklist page. */
import { all } from "@/lib/db";
import { addExperienceForm, deleteExperienceForm } from "@/actions/experience";

type Entry = { id: string; kind: string; job: string; location: string | null; doctor: string | null; hours: number; created_at: string };

const KIND_LABEL: Record<string, string> = {
  volunteer: "Clinical volunteering",
  shadowing: "Shadowing",
  paid: "Paid patient care",
  other: "Other",
};

type Part = { label: string; kinds: string[]; min: number };
/** What each pre-health track usually expects: one or more minimums, each filled by certain kinds of hours. */
const TARGETS: Record<string, { label: string; text: string; parts: Part[]; goal?: number }> = {
  "track-premed": {
    label: "Pre-Med",
    text: "at least 100 hours of physician shadowing and 50 hours of clinical experience — aim for 200 hours in total",
    parts: [
      { label: "Shadowing", kinds: ["shadowing"], min: 100 },
      { label: "Clinical", kinds: ["volunteer", "paid"], min: 50 },
    ],
    goal: 200,
  },
  "track-predental": { label: "Pre-Dental", text: "about 100+ hours shadowing a general dentist", parts: [{ label: "Shadowing", kinds: ["shadowing"], min: 100 }] },
  "track-prepa": { label: "Pre-PA", text: "about 1,000–2,000+ hours of paid, hands-on patient care (EMT, CNA, MA…)", parts: [{ label: "Paid patient care", kinds: ["paid"], min: 1000 }] },
  "track-prenursing": { label: "Pre-Nursing", text: "nurse shadowing and healthcare volunteering recommended (no strict hour minimum)", parts: [] },
};

const fmt = (n: number) => String(Number(n.toFixed(2)));

export async function ExperienceLog({ userId, trackId }: { userId: string; trackId: string | null }) {
  const rows = await all<Entry>(
    "SELECT id, kind, job, location, doctor, hours, created_at FROM experience_hours WHERE user_id = ? ORDER BY created_at DESC",
    [userId],
  );
  const total = rows.reduce((a, r) => a + r.hours, 0);
  const target = trackId ? TARGETS[trackId] : undefined;
  const sumKinds = (kinds: string[]) => rows.filter((r) => kinds.includes(r.kind)).reduce((a, r) => a + r.hours, 0);
  const parts = (target?.parts ?? []).map((p) => ({ ...p, have: sumKinds(p.kinds) }));
  const minTotal = parts.reduce((a, p) => a + p.min, 0);
  const metTotal = parts.reduce((a, p) => a + Math.min(p.have, p.min), 0);
  const pct = minTotal ? Math.round((metTotal / minTotal) * 100) : 0;
  const goalHours = target?.goal ? parts.reduce((a, p) => a + p.have, 0) : 0;

  return (
    <section id="hours" className="mt-4 scroll-mt-20 border-t border-ink-100 pt-4">
      <h4 className="text-sm font-bold text-ink-900">Clinical &amp; volunteer hours</h4>
      <div className="mt-3 space-y-4">
        {target && (
          <div>
            <p className="text-sm text-ink-700">
              {target.label} usually expects {target.text}.
            </p>
            {parts.length > 0 ? (
              <div className="mt-2">
                <div className="flex items-baseline justify-between text-xs text-ink-500">
                  <span>Minimums met</span>
                  <span className="font-bold tabular-nums text-ink-900">{pct}%</span>
                </div>
                {/* One bar split by requirement: each section's width follows its minimum. */}
                <div className="mt-1 flex gap-1">
                  {parts.map((p) => {
                    const done = p.have >= p.min;
                    return (
                      <div key={p.label} style={{ flex: p.min }} className="min-w-0">
                        <div className="h-2 overflow-hidden rounded-full bg-ink-100">
                          <div
                            className={done ? "h-full rounded-full bg-emerald-500" : "h-full rounded-full bg-amber-400"}
                            style={{ width: `${Math.min(100, (p.have / p.min) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-[11px] leading-tight text-ink-600">
                          <span className="font-semibold">{p.label}</span> {fmt(p.have)} / {p.min.toLocaleString()} h
                          {done && <span className="text-emerald-700"> ✓</span>}
                        </p>
                      </div>
                    );
                  })}
                </div>
                {target.goal ? (
                  <p className="mt-2 text-xs text-ink-600">
                    <span className="font-semibold">Goal: {target.goal} hours total</span> — {fmt(goalHours)} so far
                    {goalHours >= target.goal ? " ✓" : ` (${fmt(target.goal - goalHours)} to go)`}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <form action={addExperienceForm} method="post" className="grid gap-3 sm:grid-cols-6">
          <input type="hidden" name="track" value={trackId ?? ""} />
          <div className="sm:col-span-2">
            <label className="label" htmlFor="exp-job">Job / activity</label>
            <input id="exp-job" name="job" className="input" placeholder="ER volunteer" required />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="exp-location">Location</label>
            <input id="exp-location" name="location" className="input" placeholder="Pomona Valley Hospital" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="exp-doctor">Doctor <span className="font-normal normal-case text-ink-400">(if shadowing)</span></label>
            <input id="exp-doctor" name="doctor" className="input" placeholder="Dr. Patel" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="exp-kind">Type</label>
            <select id="exp-kind" name="kind" className="input" defaultValue="volunteer">
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="exp-hours">Hours</label>
            <input id="exp-hours" name="hours" type="number" min="0.25" step="0.25" className="input" placeholder="20" required />
          </div>
          <div className="flex items-end sm:col-span-2">
            <button type="submit" className="btn-primary">Add hours</button>
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing logged yet. Add each job or shadowing stint with its hours.</p>
        ) : (
          <div>
            <p className="mb-2 text-xs text-ink-500">
              Total logged: <span className="font-bold tabular-nums text-ink-900">{fmt(total)}</span> hours across {rows.length} entr{rows.length === 1 ? "y" : "ies"}.
            </p>
            <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-semibold text-ink-900">{r.job}</span>{" "}
                    <span className="chip border-ink-200 bg-ink-50 text-ink-600">{KIND_LABEL[r.kind] ?? r.kind}</span>
                    <p className="text-xs text-ink-500">
                      {[r.location, r.doctor ? `Dr. ${r.doctor.replace(/^dr\.?\s*/i, "")}` : null].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-bold tabular-nums text-ink-900">{fmt(r.hours)} h</span>
                    <form action={deleteExperienceForm} method="post">
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="track" value={trackId ?? ""} />
                      <button type="submit" className="text-xs text-red-700 underline" aria-label={`Remove ${r.job}`}>Remove</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
