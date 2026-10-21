"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/modules/auth";
import {
  type FeedPage,
  type LikeOutcome,
  listFeed,
  toggleLike,
} from "@/modules/feed";

export async function likeAction(postId: string): Promise<LikeOutcome> {
  const user = await getCurrentUser();
  if (!user || user.isBanned) return { status: "not_found" };

  const outcome = await toggleLike({ postId, userId: user.id });
  if (outcome.status === "ok") revalidatePath("/");

  return outcome;
}

export async function loadFeedAction(cursor: string): Promise<FeedPage> {
  const user = await getCurrentUser();

  // Курсор keyset-пагинации приходит от клиента, но он непрозрачный и
  // проверяется при разборе: подделка даёт пустую страницу, а не утечку.
  return listFeed({ viewerId: user?.id, cursor, limit: 12 });
}
