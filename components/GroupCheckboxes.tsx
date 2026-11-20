"use client";
/**
 * The counting-box picker for one course. Boxes grey out live as you tick:
 *  - GE boxes the course doesn't have are closed off from the start;
 *  - once an Educational-Objective / Breadth box is ticked, the others in
 *    that section close;
 *  - once a major/minor overlap is used up, the boxes that would need it close.
 * Ticking a major/minor box the course doesn't match (advisor exceptions,
 * study abroad…) is allowed, but saving shows a warning to confirm first.
 *
 * Still a plain <form>: one checkbox per group, name "groupId"; the server
 * action reads fd.getAll("groupId") and re-checks every rule.
 */
import { useEffect, useRef, useState } from "react";
import { boxBlockReason, nonMatching, type CountingSet, type OverlapPolicy } from "@/lib/counting";
import { cn } from "@/lib/util";

const KIND_LABEL: Record<string, string> = { ge: "GE", major: "Major", minor: "Minor", track: "Pre-health" };

export function GroupCheckboxes({
  sets,
  checked: initiallyChecked = [],
  policy,
  pairUse = {},
  strictGe = true,
  half = false,
  wide = false,
  advisorWarning = true,
}: {
  sets: CountingSet[];
  /** group ids already checked (the saved assignments). */
  checked?: string[];
  /** The student's campus double-counting policy. */
  policy: OverlapPolicy;
  /** How many other courses already share each pair of sets. */
  pairUse?: Record<string, number>;
  /** Catalog courses can only tick GE boxes they have; manual courses can't be
   *  matched, so they go through the advisor-warning path instead. */
  strictGe?: boolean;
  /** 0.5-credit course: GE and Breadth boxes stay closed. */
  half?: boolean;
  /** Lay the programs out side by side (major beside minor) instead of two columns. */
  wide?: boolean;
  /** Ask for confirmation when a ticked box isn't an official match. Off for planned (pinned) classes. */
  advisorWarning?: boolean;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initiallyChecked));
  const [warn, setWarn] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmed = useRef(false);

  const flagged = nonMatching(sets, checked);

  // Intercept the surrounding form's save to show the advisor-exception warning.
  useEffect(() => {
    const form = rootRef.current?.closest("form");
    if (!form) return;
    const onSubmit = (e: SubmitEvent) => {
      const submitter = e.submitter as HTMLButtonElement | null;
      if (submitter?.name === "release") return; // releasing needs no warning
      if (confirmed.current) {
        confirmed.current = false;
        return;
      }
      if (advisorWarning && nonMatching(sets, checked).length > 0) {
        e.preventDefault();
        setWarn(true);
      }
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [sets, checked, advisorWarning]);

  const toggle = (id: string, on: boolean) => {
    setWarn(false);
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <div ref={rootRef} className="space-y-3">
      <div
        className={cn(
          "grid gap-x-6 gap-y-3",
          wide ? "sm:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]" : "sm:grid-cols-2",
        )}
      >
        {sets.map((set) => (
          <fieldset key={set.id} className="min-w-0">
            <legend className="label">
              {KIND_LABEL[set.kind] ?? set.kind} · {set.name}
            </legend>
            <div className="grid grid-cols-1 gap-y-0.5">
              {set.groups.map((g) => {
                const reason = boxBlockReason({ set, group: g, strictGe, half, checked, policy, pairUse, sets });
                const off = reason !== null;
                const needsAdvisor = advisorWarning && !g.matches && !g.auto && !(set.kind === "ge" && strictGe);
                return (
                  <label
                    key={g.id}
                    className={cn(
                      "flex items-start gap-1.5 text-xs leading-snug",
                      g.auto
                        ? "cursor-default text-emerald-800"
                        : off
                          ? "cursor-not-allowed text-ink-300"
                          : "cursor-pointer text-ink-700",
                    )}
                    title={reason ?? undefined}
                  >
                    <input
                      type="checkbox"
                      name="groupId"
                      value={g.id}
                      checked={checked.has(g.id) || !!g.auto}
                      onChange={(e) => toggle(g.id, e.target.checked)}
                      disabled={off}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand-600"
                    />
                    <span>
                      {g.name}
                      {g.auto && (
                        <span className="ml-1 text-[10px] font-semibold text-emerald-700" title={reason ?? undefined}>
                          (required course — counts automatically)
                        </span>
                      )}
                      {needsAdvisor && !off && !g.auto && (
                        <span className="ml-1 text-[10px] text-amber-700" title="No rule match — counts only with advisor approval">
                          (advisor approval)
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {advisorWarning && warn && flagged.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
        >
          <p className="font-semibold">This course doesn’t officially qualify for:</p>
          <ul className="mt-1 list-disc pl-5">
            {flagged.map(({ set, group }) => (
              <li key={group.id}>
                {group.name} <span className="text-amber-700">({KIND_LABEL[set.kind] ?? set.kind} · {set.name})</span>
              </li>
            ))}
          </ul>
          <p className="mt-1">
            It can still count if your advisor approves an exception — some courses are chosen
            with an advisor. Keep going only if you have (or will get) that approval.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => {
                confirmed.current = true;
                setWarn(false);
                rootRef.current?.closest("form")?.requestSubmit();
              }}
            >
              Continue anyway
            </button>
            <button type="button" className="btn-ghost text-xs" onClick={() => setWarn(false)}>
              Go back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
