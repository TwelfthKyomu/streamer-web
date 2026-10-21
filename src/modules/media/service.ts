import { and, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import {
  media,
  mediaJobs,
  type mediaProcessingStatus,
  posts,
} from "@/core/db/schema";
import { env } from "@/core/env";
import { emit } from "@/core/events/bus";
import { newId } from "@/core/id";
import { logger } from "@/core/logger";
import { consume } from "@/core/ratelimit";
import { createUploadUrl, deleteObject, statObject } from "@/core/storage/s3";
import {
  extensionFor,
  type Limits,
  type MediaKind,
  type RejectionReason,
  validateUpload,
} from "./limits";

export function limits(): Limits {
  return {
    maxSizeBytes: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    maxDurationMs: env.MAX_VIDEO_DURATION_SEC * 1000,
  };
}

export type TicketOutcome =
  | { status: "ready"; uploadUrl: string; storageKey: string; kind: MediaKind }
  /** Такой файл уже лежит в хранилище — второй раз не заливаем. */
  | { status: "reuse"; mediaId: string; kind: MediaKind }
  | { status: "rejected"; reason: RejectionReason }
  | { status: "rate_limited"; retryAfterSeconds: number };

export async function createUploadTicket(params: {
  userId: string;
  mime: string;
  sizeBytes: number;
  checksum: string;
  durationMs?: number | undefined;
}): Promise<TicketOutcome> {
  const validation = validateUpload({
    mime: params.mime,
    sizeBytes: params.sizeBytes,
    durationMs: params.durationMs,
    limits: limits(),
  });

  if (!validation.ok) return { status: "rejected", reason: validation.reason };

  const rate = await consume("upload", params.userId);
  if (!rate.allowed) {
    return {
      status: "rate_limited",
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }

  // Индекс media_checksum_idx стоит именно для этого: один и тот же файл не
  // должен занимать место дважды, а повторная заливка мема — обычное дело.
  const existing = await db.query.media.findFirst({
    where: and(
      eq(media.checksum, params.checksum),
      eq(media.ownerId, params.userId),
    ),
  });

  if (existing) {
    return { status: "reuse", mediaId: existing.id, kind: validation.kind };
  }

  const storageKey = `media/${params.userId}/${newId()}.${extensionFor(params.mime)}`;
  const uploadUrl = await createUploadUrl(storageKey, params.mime);

  return { status: "ready", uploadUrl, storageKey, kind: validation.kind };
}

export const captionMaxLength = 500;

export type PublishOutcome =
  | { status: "ok"; postId: string; mediaId: string }
  | { status: "not_uploaded" }
  | { status: "mismatch" }
  | { status: "rejected"; reason: RejectionReason };

export async function publishUpload(params: {
  userId: string;
  caption: string | null;
  checksum: string;
  mime: string;
  sizeBytes: number;
  storageKey?: string | undefined;
  mediaId?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
}): Promise<PublishOutcome> {
  const validation = validateUpload({
    mime: params.mime,
    sizeBytes: params.sizeBytes,
    durationMs: params.durationMs,
    limits: limits(),
  });

  if (!validation.ok) return { status: "rejected", reason: validation.reason };

  // Нормализация подписи живёт здесь, а не в серверном действии: инвариант
  // должен держать сервис, иначе любой другой вызов его обойдёт.
  const caption = params.caption?.trim().slice(0, captionMaxLength) || null;

  let mediaId = params.mediaId;

  if (!mediaId) {
    if (!params.storageKey) return { status: "not_uploaded" };

    // Presigned-ссылка связывает только ключ и тип, но не размер: клиент мог
    // залить что угодно, поэтому объект проверяется по факту, а не по словам.
    const head = await statObject(params.storageKey);
    if (!head) return { status: "not_uploaded" };

    const sizeMatches = head.sizeBytes === params.sizeBytes;
    const typeMatches = head.contentType === params.mime;
    const withinLimit = head.sizeBytes <= limits().maxSizeBytes;

    if (!sizeMatches || !typeMatches || !withinLimit) {
      logger.warn(
        {
          storageKey: params.storageKey,
          declared: { size: params.sizeBytes, mime: params.mime },
          actual: head,
        },
        "загруженный объект не совпал с заявленным, удаляем",
      );

      await deleteObject(params.storageKey);
      return { status: "mismatch" };
    }

    const storageKey = params.storageKey;

    // Видео без задачи так и осталось бы оригиналом на 100 МБ, поэтому запись
    // и постановка в очередь воркера идут одной транзакцией.
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(media)
        .values({
          ownerId: params.userId,
          kind: validation.kind,
          storageKey,
          mime: params.mime,
          sizeBytes: params.sizeBytes,
          checksum: params.checksum,
          width: params.width ?? null,
          height: params.height ?? null,
          durationMs: params.durationMs ?? null,
        })
        .returning({ id: media.id });

      if (row && validation.kind === "video") {
        await tx.insert(mediaJobs).values({ mediaId: row.id });
      }

      return row;
    });

    if (!created) return { status: "not_uploaded" };
    mediaId = created.id;
  }

  const [post] = await db
    .insert(posts)
    .values({
      authorId: params.userId,
      mediaId,
      caption,
      // Премодерация обязательна: за пользовательский контент отвечает
      // площадка, поэтому в ленту пост попадает только после решения.
      status: "pending",
    })
    .returning({ id: posts.id });

  if (!post) return { status: "not_uploaded" };

  await emit("post.created", { postId: post.id, authorId: params.userId });

  logger.info(
    { postId: post.id, userId: params.userId },
    "пост отправлен на модерацию",
  );

  return { status: "ok", postId: post.id, mediaId };
}

export type ProcessingStatus =
  (typeof mediaProcessingStatus.enumValues)[number];

/** Статус обработки медиа владельца: чужое неотличимо от несуществующего. */
export async function processingStatus(params: {
  mediaId: string;
  ownerId: string;
}): Promise<ProcessingStatus | null> {
  const row = await db.query.media.findFirst({
    columns: { processingStatus: true },
    where: and(eq(media.id, params.mediaId), eq(media.ownerId, params.ownerId)),
  });

  return row?.processingStatus ?? null;
}
