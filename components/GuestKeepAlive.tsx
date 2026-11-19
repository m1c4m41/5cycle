"use client";
/** Renews a no-account visitor's cookie on every page load so it never lapses. */
import { useEffect } from "react";

export function GuestKeepAlive() {
  useEffect(() => {
    fetch("/api/keepalive", { method: "POST", credentials: "same-origin" }).catch(() => {});
  }, []);
  return null;
}
