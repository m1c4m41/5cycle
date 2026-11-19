"use client";
/**
 * Shared state for the catalog page's live weekly grid:
 *  - previews: classes you've clicked in the list — drawn as shaded boxes on the
 *    grid, but NOT in your plan until you press Add;
 *  - hidden: classes in your plan you've switched off on the grid (to try other
 *    schedules). Hidden classes stay in the plan; this is only a view toggle,
 *    remembered per term in this browser.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { GridSection } from "@/lib/grid-blocks";

type Ctx = {
  previews: Record<string, GridSection>;
  togglePreview: (s: GridSection) => void;
  clearPreviews: () => void;
  hidden: Set<string>;
  toggleHidden: (id: string) => void;
  showAll: () => void;
};

const GridCtx = createContext<Ctx | null>(null);

export function useCatalogGrid(): Ctx {
  const c = useContext(GridCtx);
  if (!c) throw new Error("useCatalogGrid outside CatalogGridProvider");
  return c;
}
/** Safe variant for components that may render outside the provider. */
export const useCatalogGridOptional = () => useContext(GridCtx);

export function CatalogGridProvider({ term, children }: { term: string; children: ReactNode }) {
  const key = `cycle_grid_hidden_${term}`;
  const [previews, setPreviews] = useState<Record<string, GridSection>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setHidden(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setHidden(new Set());
    }
  }, [key]);

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* private mode — the toggle still works for this visit */
      }
    },
    [key],
  );

  const value = useMemo<Ctx>(
    () => ({
      previews,
      togglePreview: (s) =>
        setPreviews((p) => {
          const next = { ...p };
          if (next[s.id]) delete next[s.id];
          else next[s.id] = s;
          return next;
        }),
      clearPreviews: () => setPreviews({}),
      hidden,
      toggleHidden: (id) =>
        setHidden((h) => {
          const next = new Set(h);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          persist(next);
          return next;
        }),
      showAll: () => {
        const next = new Set<string>();
        setHidden(next);
        persist(next);
      },
    }),
    [previews, hidden, persist],
  );

  return <GridCtx.Provider value={value}>{children}</GridCtx.Provider>;
}
