"use client";
/** Wraps a catalog class card: clicking the card (not its buttons or links)
 *  toggles a shaded preview of it on the weekly grid. */
import type { ReactNode } from "react";
import { useCatalogGridOptional } from "@/components/CatalogGridProvider";
import type { GridSection } from "@/lib/grid-blocks";
import { cn } from "@/lib/util";

export function PreviewCard({
  section,
  inPlan,
  enabled = true,
  children,
}: {
  section: GridSection;
  inPlan: boolean;
  /** Off for signed-out visitors (no grid to preview on). */
  enabled?: boolean;
  children: ReactNode;
}) {
  const grid = useCatalogGridOptional();
  const on = !!grid?.previews[section.id] && !inPlan;
  const canPreview = enabled && !inPlan && section.meetings.length > 0;
  return (
    <div
      className={cn(
        "rounded-2xl transition-shadow",
        canPreview && "cursor-pointer",
        on && "ring-2 ring-brand-500 ring-offset-2",
      )}
      title={canPreview ? (on ? "Click to remove the preview from your grid" : "Click to preview on your grid") : undefined}
      onClick={(e) => {
        if (!grid || !canPreview) return;
        // Leave links, buttons, form fields and the dropdown alone.
        if ((e.target as HTMLElement).closest("a, button, input, select, textarea, label, summary, details")) return;
        grid.togglePreview(section);
      }}
    >
      {children}
    </div>
  );
}
