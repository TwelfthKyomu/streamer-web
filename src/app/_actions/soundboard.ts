"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/modules/auth";
import { type PlayOutcome, play } from "@/modules/soundboard";

export async function playSoundAction(soundId: string): Promise<PlayOutcome> {
  const user = await getCurrentUser();
  if (!user || user.isBanned) return { status: "not_found" };

  const outcome = await play({ soundId, userId: user.id });
  if (outcome.status === "played") revalidatePath("/soundboard");

  return outcome;
}
