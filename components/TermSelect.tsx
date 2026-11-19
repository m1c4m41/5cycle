"use client";
import { rememberTerm } from "./TermRemember";

type TermOption = { id: string; label: string; is_current?: number | boolean };

/**
 * A term dropdown that re-submits its own form the moment the user picks a
 * different term — so the weekly grid and results switch to that term without
 * needing to press a separate button. With JavaScript disabled it behaves as
 * an ordinary form field: the surrounding submit button (or Enter) still
 * applies the chosen term.
 */
export function TermSelect({
  options,
  value,
  id = "term",
  className = "input w-auto",
}: {
  options: TermOption[];
  value: string;
  id?: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      name="term"
      defaultValue={value}
      className={className}
      onChange={(e) => {
        rememberTerm(e.currentTarget.value);
        const form = e.currentTarget.form;
        if (!form) return;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      }}
    >
      {options.length === 0 && <option value={value}>{value || "—"}</option>}
      {options.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
          {t.is_current ? " (current)" : ""}
        </option>
      ))}
    </select>
  );
}
