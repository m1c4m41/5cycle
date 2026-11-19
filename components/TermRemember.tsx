"use client";
import { useEffect } from "react";

/** Writes the term cookie (client-side, one year) — server components can't. */
export function rememberTerm(term: string) {
  if (!/^(FA|SP|SU)\d{4}$/.test(term)) return;
  try {
    document.cookie = `term=${term}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* cookies blocked — the URL still carries the term */
  }
}

/** Renders nothing; keeps the cookie in step with the term the page is showing. */
export function TermRemember({ term }: { term: string }) {
  useEffect(() => rememberTerm(term), [term]);
  return null;
}
