import { on } from "@/core/events/bus";
import { logger } from "@/core/logger";
import { getPrimaryStreamerId, send } from "@/modules/overlay";
import { checkForEvent, type TrackedEvent } from "./service";

let registered = false;

async function handle(userId: string, event: TrackedEvent): Promise<void> {
  const unlocked = await checkForEvent({ userId, event });
  if (unlocked.length === 0) return;

  // Бейдж уже записан в базу, объявление — приятный бонус. Если оверлей
  // недоступен, достижение всё равно остаётся у пользователя.
  try {
    const streamerId = await getPrimaryStreamerId();
    if (!streamerId) return;

    for (const badge of unlocked) {
      await send(streamerId, {
        type: "alert",
        title: `${badge.icon} ${badge.title}`,
        body: badge.description,
      });
    }
  } catch (error) {
    logger.warn({ err: error }, "не удалось объявить достижение в оверлее");
  }
}

export function registerAchievementSubscribers(): void {
  if (registered) return;
  registered = true;

  on("post.approved", async (event) => {
    await handle(event.payload.authorId, "post.approved");
  });

  on("post.liked", async (event) => {
    await handle(event.payload.authorId, "post.liked");
  });

  on("sound.played", async (event) => {
    await handle(event.payload.userId, "sound.played");
  });

  on("user.visit", async (event) => {
    await handle(event.payload.userId, "user.visit");
  });

  logger.info("подписчики достижений зарегистрированы");
}
