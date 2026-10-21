import { and, countDistinct, eq, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import {
  achievements,
  pointTransactions,
  postLikes,
  posts,
  soundPlays,
  userAchievements,
} from "@/core/db/schema";
import { logger } from "@/core/logger";

export type UnlockedBadge = {
  code: string;
  title: string;
  description: string;
  icon: string;
};

/**
 * События, по которым вообще имеет смысл пересчитывать бейджи. Условия
 * достижений лежат в базе как jsonb, поэтому список держим здесь: он
 * определяет, на что подписываться и как измерять прогресс.
 */
export const trackedEvents = [
  "post.approved",
  "post.liked",
  "sound.played",
  "user.visit",
] as const;

export type TrackedEvent = (typeof trackedEvents)[number];

/**
 * Прогресс считается запросом по факту, а не отдельным счётчиком.
 * Счётчик пришлось бы чинить после каждого удаления поста или отката
 * модерации, а запрос всегда отражает текущее состояние.
 */
async function measure(event: TrackedEvent, userId: string): Promise<number> {
  switch (event) {
    case "post.approved": {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(posts)
        .where(and(eq(posts.authorId, userId), eq(posts.status, "approved")));
      return row?.value ?? 0;
    }

    case "post.liked": {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(postLikes)
        .innerJoin(posts, eq(posts.id, postLikes.postId))
        .where(eq(posts.authorId, userId));
      return row?.value ?? 0;
    }

    case "sound.played": {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(soundPlays)
        .where(eq(soundPlays.userId, userId));
      return row?.value ?? 0;
    }

    case "user.visit": {
      const [row] = await db
        .select({
          value: countDistinct(sql`date(${pointTransactions.createdAt})`),
        })
        .from(pointTransactions)
        .where(
          and(
            eq(pointTransactions.userId, userId),
            eq(pointTransactions.reason, "daily_visit"),
          ),
        );
      return Number(row?.value ?? 0);
    }
  }
}

/**
 * Пересчитывает бейджи, завязанные на событие, и выдаёт те, чей порог взят.
 * Возвращает только что открытые — чтобы было чем хвастаться в оверлее.
 */
export async function checkForEvent(params: {
  userId: string;
  event: TrackedEvent;
}): Promise<UnlockedBadge[]> {
  const candidates = await db
    .select()
    .from(achievements)
    .where(
      and(
        eq(achievements.enabled, true),
        sql`${achievements.condition}->>'event' = ${params.event}`,
      ),
    );

  if (candidates.length === 0) return [];

  const owned = await db
    .select({ code: userAchievements.achievementCode })
    .from(userAchievements)
    .where(eq(userAchievements.userId, params.userId));

  const ownedCodes = new Set(owned.map((row) => row.code));
  const pending = candidates.filter((badge) => !ownedCodes.has(badge.code));
  if (pending.length === 0) return [];

  // Метрика на событие одна, поэтому считаем её один раз на все пороги.
  const value = await measure(params.event, params.userId);
  const unlocked: UnlockedBadge[] = [];

  for (const badge of pending) {
    if (value < badge.condition.threshold) continue;

    const inserted = await db
      .insert(userAchievements)
      .values({ userId: params.userId, achievementCode: badge.code })
      .onConflictDoNothing()
      .returning({ code: userAchievements.achievementCode });

    // Пустой результат — значит бейдж уже выдан параллельным обработчиком.
    if (inserted.length === 0) continue;

    unlocked.push({
      code: badge.code,
      title: badge.title,
      description: badge.description,
      icon: badge.icon,
    });

    logger.info(
      { userId: params.userId, badge: badge.code, value },
      "открыто достижение",
    );
  }

  return unlocked;
}

export async function listForUser(userId: string) {
  return db
    .select({
      code: achievements.code,
      title: achievements.title,
      description: achievements.description,
      icon: achievements.icon,
      unlockedAt: userAchievements.unlockedAt,
    })
    .from(userAchievements)
    .innerJoin(
      achievements,
      eq(achievements.code, userAchievements.achievementCode),
    )
    .where(eq(userAchievements.userId, userId))
    .orderBy(userAchievements.unlockedAt);
}
