import { asc, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { soundPlays, sounds } from "@/core/db/schema";
import { emit } from "@/core/events/bus";
import { logger } from "@/core/logger";
import { consume } from "@/core/ratelimit";
import { redis } from "@/core/redis";
import { publicUrl } from "@/core/storage/s3";
import { getPrimaryStreamerId, send } from "@/modules/overlay";
import { refund, spend } from "@/modules/points";

const GLOBAL_COOLDOWN_SECONDS = 6;

export type Sound = {
  id: string;
  name: string;
  url: string;
  durationMs: number;
  cost: number;
  cooldownSeconds: number;
};

export type PlayOutcome =
  | { status: "played"; balance: number }
  | { status: "not_found" }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "insufficient"; balance: number; cost: number }
  | { status: "offline" }
  | { status: "failed" };

export async function list(): Promise<Sound[]> {
  const rows = await db.query.sounds.findMany({
    where: eq(sounds.enabled, true),
    orderBy: [asc(sounds.name)],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: publicUrl(row.storageKey),
    durationMs: row.durationMs,
    cost: row.cost,
    cooldownSeconds: row.cooldownSeconds,
  }));
}

async function claimCooldown(key: string, seconds: number): Promise<number> {
  if (seconds <= 0) return 0;
  const claimed = await redis.set(key, "1", "EX", seconds, "NX");
  if (claimed) return 0;
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : seconds;
}

export async function play(params: {
  soundId: string;
  userId: string;
}): Promise<PlayOutcome> {
  const limited = await consume("soundboard", params.userId);
  if (!limited.allowed) {
    return {
      status: "rate_limited",
      retryAfterSeconds: limited.retryAfterSeconds,
    };
  }

  const sound = await db.query.sounds.findFirst({
    where: eq(sounds.id, params.soundId),
  });

  if (!sound?.enabled) return { status: "not_found" };

  const streamerId = await getPrimaryStreamerId();
  if (!streamerId) return { status: "offline" };

  const globalWait = await claimCooldown(
    "cd:sound:global",
    GLOBAL_COOLDOWN_SECONDS,
  );
  if (globalWait > 0) {
    return { status: "cooldown", retryAfterSeconds: globalWait };
  }

  const soundWait = await claimCooldown(
    `cd:sound:${sound.id}`,
    sound.cooldownSeconds,
  );
  if (soundWait > 0) {
    return { status: "cooldown", retryAfterSeconds: soundWait };
  }

  const idempotencyKey = `sound:${sound.id}:${params.userId}:${Date.now()}`;

  const payment =
    sound.cost > 0
      ? await spend({
          userId: params.userId,
          amount: sound.cost,
          reason: "sound_played",
          refType: "sound",
          refId: sound.id,
          idempotencyKey,
        })
      : ({ status: "spent", balance: 0, transactionId: 0 } as const);

  if (payment.status === "insufficient") {
    return {
      status: "insufficient",
      balance: payment.balance,
      cost: sound.cost,
    };
  }

  if (payment.status === "duplicate") return { status: "failed" };

  try {
    await send(streamerId, {
      type: "sound",
      soundId: sound.id,
      name: sound.name,
      url: publicUrl(sound.storageKey),
      playedBy: params.userId,
    });
  } catch (error) {
    logger.error({ err: error, soundId: sound.id }, "overlay publish failed");

    if (sound.cost > 0) {
      await refund({
        userId: params.userId,
        amount: sound.cost,
        reason: "sound_refund",
        refType: "sound",
        refId: sound.id,
        idempotencyKey: `refund:${idempotencyKey}`,
      });
    }

    return { status: "failed" };
  }

  await db.insert(soundPlays).values({
    soundId: sound.id,
    userId: params.userId,
    transactionId: payment.transactionId > 0 ? payment.transactionId : null,
  });

  await emit("sound.played", {
    soundId: sound.id,
    userId: params.userId,
    name: sound.name,
  });

  return { status: "played", balance: payment.balance };
}
