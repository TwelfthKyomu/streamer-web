"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/modules/auth";
import {
  createUploadTicket,
  type ProcessingStatus,
  type PublishOutcome,
  processingStatus,
  publishUpload,
  type TicketOutcome,
} from "@/modules/media";

export type Unauthorized = { status: "unauthorized" };

export async function requestUploadAction(input: {
  mime: string;
  sizeBytes: number;
  checksum: string;
  durationMs?: number;
}): Promise<TicketOutcome | Unauthorized> {
  const user = await getCurrentUser();
  if (!user || user.isBanned) return { status: "unauthorized" };

  return createUploadTicket({
    userId: user.id,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum,
    durationMs: input.durationMs,
  });
}

export async function publishUploadAction(input: {
  caption: string;
  checksum: string;
  mime: string;
  sizeBytes: number;
  storageKey?: string;
  mediaId?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}): Promise<PublishOutcome | Unauthorized> {
  const user = await getCurrentUser();
  if (!user || user.isBanned) return { status: "unauthorized" };

  const outcome = await publishUpload({
    userId: user.id,
    caption: input.caption,
    checksum: input.checksum,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
    storageKey: input.storageKey,
    mediaId: input.mediaId,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
  });

  // Пост уходит в премодерацию, поэтому в ленте он ещё не появится —
  // обновляем очередь модератора.
  if (outcome.status === "ok") revalidatePath("/moderation");

  return outcome;
}

export async function mediaStatusAction(
  mediaId: string,
): Promise<ProcessingStatus | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  // Идентификатор приходит от клиента: не-uuid Postgres отверг бы ошибкой.
  if (!z.uuid().safeParse(mediaId).success) return null;

  return processingStatus({ mediaId, ownerId: user.id });
}
