/**
 * The multi-box requirement picker. One course can be checked off against
 * several boxes at once — across sets (GE + major + minor) and, for
 * Educational-Objective / Breadth groups, more than once inside a set.
 *
 * JS-free: a plain <form> with one checkbox per requirement group, name
 * "groupId"; the server action reads fd.getAll("groupId").
 */
import type { RequirementSet } from "@/lib/types";
import { isBreadthGroup, isDoubleDipGroup } from "@/lib/requirements";
import { cn } from "@/lib/util";

const KIND_LABEL: Record<string, string> = { ge: "GE", major: "Major", minor: "Minor" };

export function GroupCheckboxes({
  sets,
  checked = [],
  disabledHalf = false,
}: {
  sets: RequirementSet[];
  /** group ids already checked (defaults come from the saved assignments). */
  checked?: string[];
  /** For 0.5-credit courses: GE and Breadth boxes are disabled — a full
   *  credit is needed to tick them (the credits still count toward totals). */
  disabledHalf?: boolean;
}) {
  const checkedSet = new Set(checked);
  return (
    <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      {sets.map((set) => (
        <fieldset key={set.id} className="min-w-0">
          <legend className="label">
            {KIND_LABEL[set.kind] ?? set.kind} · {set.name}
          </legend>
          <div className="grid grid-cols-1 gap-y-0.5">
            {set.groups.map((g) => {
              const off = disabledHalf && (set.kind === "ge" || isBreadthGroup(g));
              return (
                <label
                  key={g.id}
                  className={cn(
                    "flex items-start gap-1.5 text-xs leading-snug",
                    off ? "cursor-not-allowed text-ink-300" : "cursor-pointer text-ink-700",
                  )}
                >
                  <input
                    type="checkbox"
                    name="groupId"
                    value={g.id}
                    defaultChecked={checkedSet.has(g.id)}
                    disabled={off}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand-600"
                    title={
                      off
                        ? "0.5-credit courses can’t tick a GE or Breadth box — a full credit is needed. Its credits still count toward your graduation total."
                        : undefined
                    }
                  />
                  <span>
                    {g.name}
                    {isDoubleDipGroup(g) &&
                      !/writing educational objective/i.test(g.name) && (
                        <span className="text-ink-400"> · may double-dip</span>
                      )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
