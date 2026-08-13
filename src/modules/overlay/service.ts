import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/core/db/client";
import { overlayTokens, profiles } from "@/core/db/schema";
import { channels, publish } from "@/core/realtime/centrifugo";

export type OverlayEvent =
  | {
      type: "sound";
      soundId: string;
      name: string;
      url: string;
      playedBy: string;
    }
  | { type: "alert"; title: string; body: string | null }
  | { type: "post"; postId: string; caption: string | null; url: string };

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function getPrimaryStreamerId(): Promise<string | null> {
  const admin = await db.query.profiles.findFirst({
    where: eq(profiles.role, "admin"),
  });
  return admin?.userId ?? null;
}

export async function resolveToken(token: string): Promise<string | null> {
  const record = await db.query.overlayTokens.findFirst({
    where: and(eq(overlayTokens.token, token), isNull(overlayTokens.revokedAt)),
  });

  if (!record) return null;

  await db
    .update(overlayTokens)
    .set({ lastSeenAt: new Date() })
    .where(eq(overlayTokens.id, record.id));

  return record.streamerUserId;
}

export async function ensureToken(streamerUserId: string): Promise<string> {
  const existing = await db.query.overlayTokens.findFirst({
    where: and(
      eq(overlayTokens.streamerUserId, streamerUserId),
      isNull(overlayTokens.revokedAt),
    ),
  });

  if (existing) return existing.token;

  const token = generateToken();
  await db.insert(overlayTokens).values({ streamerUserId, token });
  return token;
}

export async function rotateToken(streamerUserId: string): Promise<string> {
  const token = generateToken();

  await db.transaction(async (tx) => {
    await tx
      .update(overlayTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(overlayTokens.streamerUserId, streamerUserId),
          isNull(overlayTokens.revokedAt),
        ),
      );

    await tx.insert(overlayTokens).values({ streamerUserId, token });
  });

  return token;
}

export async function send(
  streamerUserId: string,
  event: OverlayEvent,
): Promise<void> {
  await publish(channels.overlay(streamerUserId), { ...event });
}
