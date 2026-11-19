"use server";
import { revalidatePath } from "next/cache";
import { markAllRead } from "@/lib/notify";
import { assertActionsEnabled, userOrRedirect } from "@/lib/server";

export async function markAllReadAction(): Promise<void> {
  assertActionsEnabled();
  const user = await userOrRedirect();
  await markAllRead(user.id);
  revalidatePath("/", "layout");
  revalidatePath("/notifications");
}
