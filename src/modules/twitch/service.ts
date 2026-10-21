import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { streamStatus, twitchEvents, twitchLinks } from "@/core/db/schema";
import { emit } from "@/core/events/bus";
import { logger } from "@/core/logger";
import { channels, publish } from "@/core/realtime/centrifugo";
import { type StatusChange, toStatusChange } from "./status";

/** Снимок эфира в том виде, в каком он уходит на клиент. */
export type StreamSnapshot = {
  isLive: boolean;
  title: string | null;
  game: string | null;
  startedAt: string | null;
};

const singletonId = 1;

async function currentStatus(): Promise<StreamSnapshot> {
  const row = await db.query.streamStatus.findFirst();

  return {
    isLive: row?.isLive ?? false,
    title: row?.title ?? null,
    game: row?.game ?? null,
    startedAt: row?.startedAt?.toISOString() ?? null,
  };
}

export async function getStatus(): Promise<StreamSnapshot> {
  return currentStatus();
}

/** Ветку "ignored" сюда не пускаем — писать по ней нечего. */
type EffectiveChange = Exclude<StatusChange, { kind: "ignored" }>;

async function applyChange(change: EffectiveChange): Promise<StreamSnapshot> {
  // channel.update приходит и во время эфира, и вне его, поэтому isLive там не
  // трогаем — иначе смена названия в офлайне «включит» стрим.
  const patch =
    change.kind === "online"
      ? { isLive: true, startedAt: change.startedAt, updatedAt: new Date() }
      : change.kind === "offline"
        ? {
            isLive: false,
            startedAt: null,
            viewerCount: null,
            updatedAt: new Date(),
          }
        : { title: change.title, game: change.game, updatedAt: new Date() };

  await db
    .insert(streamStatus)
    .values({ id: singletonId, ...patch })
    .onConflictDoUpdate({ target: streamStatus.id, set: patch });

  return currentStatus();
}

async function broadcast(snapshot: StreamSnapshot): Promise<void> {
  // Падение realtime не должно ронять обработку вебхука: Twitch воспримет
  // ошибку как недоставку и начнёт слать повторы, а состояние уже записано.
  try {
    await publish(channels.stream(), { type: "stream.status", ...snapshot });
  } catch (error) {
    logger.error({ err: error }, "не удалось опубликовать статус стрима");
  }
}

export type NotificationOutcome = "processed" | "duplicate" | "ignored";

export async function handleNotification(params: {
  messageId: string;
  subscriptionType: string;
  event: unknown;
  payload: unknown;
}): Promise<NotificationOutcome> {
  // Дедупликация до всякой обработки: Twitch честно предупреждает, что одно и
  // то же сообщение может прийти несколько раз, а messageId здесь первичный
  // ключ — вставка сама отсечёт повтор без гонки.
  const inserted = await db
    .insert(twitchEvents)
    .values({
      messageId: params.messageId,
      type: params.subscriptionType,
      payload: params.payload as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ messageId: twitchEvents.messageId });

  if (inserted.length === 0) {
    logger.debug(
      { messageId: params.messageId, type: params.subscriptionType },
      "повторное сообщение EventSub, пропускаем",
    );
    return "duplicate";
  }

  const change = toStatusChange(params.subscriptionType, params.event);
  if (change.kind === "ignored") return "ignored";

  const snapshot = await applyChange(change);
  await broadcast(snapshot);

  if (change.kind === "online") {
    await emit("stream.online", { title: snapshot.title, game: snapshot.game });
  } else if (change.kind === "offline") {
    await emit("stream.offline", {});
  }

  logger.info(
    { type: params.subscriptionType, isLive: snapshot.isLive },
    "обработано событие Twitch",
  );

  return "processed";
}

export async function linkAccount(params: {
  userId: string;
  twitchUserId: string;
  login: string;
}): Promise<void> {
  await db
    .insert(twitchLinks)
    .values({
      userId: params.userId,
      twitchUserId: params.twitchUserId,
      login: params.login,
      lastSyncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: twitchLinks.userId,
      set: {
        twitchUserId: params.twitchUserId,
        login: params.login,
        lastSyncedAt: new Date(),
      },
    });
}

/** Twitch-идентификатор владельца канала: на него оформляются подписки. */
export async function getBroadcasterId(userId: string): Promise<string | null> {
  const link = await db.query.twitchLinks.findFirst({
    where: eq(twitchLinks.userId, userId),
  });

  return link?.twitchUserId ?? null;
}
