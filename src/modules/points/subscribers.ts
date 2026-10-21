import { on } from "@/core/events/bus";
import { logger } from "@/core/logger";
import { award } from "./service";

/**
 * Подписчики шины: до этого файла события уходили в пустоту, и баллы не
 * начислялись вообще. Ключи идемпотентности строятся из идентификаторов
 * источника, поэтому повторная доставка события ничего не удваивает —
 * на point_transactions.idempotency_key стоит уникальный индекс.
 */

let registered = false;

function day(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Заход эмитится на каждый рендер страницы, а начисляется раз в сутки.
 * Память процесса гасит повторы до похода в базу: без этого каждый переход
 * по сайту стоил бы двух лишних запросов ради заведомо известного ответа.
 */
const seenVisits = new Set<string>();

function alreadyCountedToday(userId: string): boolean {
  const key = `${userId}:${day()}`;
  if (seenVisits.has(key)) return true;

  // Смена суток обнуляет кэш целиком: ключи вчерашнего дня больше не нужны.
  for (const seen of seenVisits) {
    if (!seen.endsWith(day())) seenVisits.delete(seen);
  }

  seenVisits.add(key);
  return false;
}

export function registerPointsSubscribers(): void {
  // dev-сервер перезагружает модули на лету, а обработчики живут в памяти
  // процесса: без флага после каждой правки подписка добавлялась бы заново.
  if (registered) return;
  registered = true;

  on("post.approved", async (event) => {
    await award({
      userId: event.payload.authorId,
      eventType: "post_approved",
      idempotencyKey: `post_approved:${event.payload.postId}`,
      refType: "post",
      refId: event.payload.postId,
    });
  });

  on("post.liked", async (event) => {
    // Лайк самому себе баллов не приносит, иначе экономика ломается об
    // самый очевидный эксплойт.
    if (event.payload.authorId === event.payload.likedBy) return;

    await award({
      userId: event.payload.authorId,
      eventType: "post_liked",
      idempotencyKey: `post_liked:${event.payload.postId}:${event.payload.likedBy}`,
      refType: "post",
      refId: event.payload.postId,
    });
  });

  on("comment.created", async (event) => {
    await award({
      userId: event.payload.authorId,
      eventType: "comment_created",
      idempotencyKey: `comment_created:${event.payload.commentId}`,
      refType: "comment",
      refId: event.payload.commentId,
    });
  });

  on("user.visit", async (event) => {
    if (alreadyCountedToday(event.payload.userId)) return;

    await award({
      userId: event.payload.userId,
      eventType: "daily_visit",
      // Дата в ключе: один заход в сутки, даже если событие придёт сто раз.
      idempotencyKey: `daily_visit:${event.payload.userId}:${day()}`,
    });
  });

  logger.info("подписчики начисления баллов зарегистрированы");
}
