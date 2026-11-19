"use client";
/** Shows an ISO timestamp in the viewer's own time zone, with seconds. */
import { useEffect, useState } from "react";

export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText(
      new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  }, [iso]);
  return <time dateTime={iso}>{text || iso.replace("T", " ").slice(0, 19) + " UTC"}</time>;
}
