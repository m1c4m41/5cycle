/** Pre-health track picker (pre-med, pre-dental, pre-PA, pre-nursing). */
import type { RequirementSet } from "@/lib/types";
import { TRACK_IDS } from "@/lib/prehealth";

export function TrackSelect({
  tracks,
  defaultValue = "",
  optionalLabel = false,
}: {
  tracks: RequirementSet[];
  defaultValue?: string;
  optionalLabel?: boolean;
}) {
  return (
    <div>
      <label className="label" htmlFor="trackId">
        Pre-health track{" "}
        {optionalLabel && <span className="font-normal normal-case text-ink-400">(optional)</span>}
      </label>
      <select id="trackId" name="trackId" defaultValue={defaultValue} className="input">
        <option value="">None</option>
        {[...tracks].sort((a, b) => TRACK_IDS.indexOf(a.id) - TRACK_IDS.indexOf(b.id)).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-ink-500">
        Adds a checklist of the courses that program usually asks for. It can overlap your major.
      </p>
    </div>
  );
}
