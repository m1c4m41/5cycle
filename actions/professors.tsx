"use server";
/** "Load more" for the professors directory's continuous scroll. */
import type { ReactNode } from "react";
import { fetchProfessors } from "@/lib/professors-list";
import { ProfessorLis, ProfessorTrs } from "@/components/ProfessorRows";

export async function loadMoreProfessors(
  sp: Record<string, string>,
  offset: number,
  limit: number,
): Promise<{ trs: ReactNode; lis: ReactNode; count: number; total: number }> {
  const off = Math.max(0, Math.floor(Number(offset)) || 0);
  const lim = Math.min(Math.max(1, Math.floor(Number(limit)) || 40), 100);
  const { rows, total, ayLabel } = await fetchProfessors(sp, off, lim);
  return { trs: <ProfessorTrs rows={rows} />, lis: <ProfessorLis rows={rows} ayLabel={ayLabel} />, count: rows.length, total };
}
