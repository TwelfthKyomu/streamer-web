"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/modules/auth";
import { type LikeOutcome, toggleLike } from "@/modules/feed";

export async function likeAction(postId: string): Promise<LikeOutcome> {
  const user = await getCurrentUser();
  if (!user || user.isBanned) return { status: "not_found" };

  const outcome = await toggleLike({ postId, userId: user.id });
  if (outcome.status === "ok") revalidatePath("/");

  return outcome;
}
