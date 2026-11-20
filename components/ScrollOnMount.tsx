"use client";
/** Scrolls to an element id when the page loads (server-action redirects drop the #hash). */
import { useEffect } from "react";

export function ScrollOnMount({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [id]);
  return null;
}
