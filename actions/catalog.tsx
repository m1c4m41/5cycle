"use server";
/** "Load more" for the catalog's continuous scroll: returns the next batch of
 *  cards, rendered on the server, so nothing already on screen is re-fetched. */
import type { ReactNode } from "react";
import { searchSections } from "@/lib/catalog";
import { currentUser } from "@/lib/session";
import { enrolledSections } from "@/lib/schedule";
import { setsForUser } from "@/lib/requirements";
import { queryFromSp } from "@/lib/catalog-params";
import { SectionCards } from "@/components/SectionCards";
import type { RequirementSet, Section } from "@/lib/types";

export async function loadMoreSections(
  sp: Record<string, string>,
  term: string,
  offset: number,
  limit: number,
): Promise<{ node: ReactNode; count: number; total: number }> {
  const user = await currentUser();
  const q = queryFromSp(sp, term, sp.notAt === "1" ? (user?.school ?? "") : "");
  const safeOffset = Math.max(0, Math.floor(Number(offset)) || 0);
  const [{ rows, total }, planned, userSets] = await Promise.all([
    searchSections({ ...q, limit: Math.min(Math.max(1, Math.floor(Number(limit)) || 40), 100), offset: safeOffset }),
    user ? enrolledSections(user.id, term) : Promise.resolve([] as Section[]),
    user ? setsForUser(user) : Promise.resolve([] as RequirementSet[]),
  ]);
  return {
    node: <SectionCards rows={rows} sp={sp} signedIn={!!user} planned={planned} userSets={userSets} />,
    count: rows.length,
    total,
  };
}
