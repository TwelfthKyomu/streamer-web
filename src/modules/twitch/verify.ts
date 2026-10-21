import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Заголовки, которыми Twitch подписывает вебхуки EventSub.
 * Имена в нижнем регистре: Headers в fetch регистронезависимы, но так
 * очевиднее, что мы читаем именно то, что кладёт Twitch.
 */
export const twitchHeaders = {
  messageId: "twitch-eventsub-message-id",
  timestamp: "twitch-eventsub-message-timestamp",
  signature: "twitch-eventsub-message-signature",
  messageType: "twitch-eventsub-message-type",
  subscriptionType: "twitch-eventsub-subscription-type",
} as const;

/**
 * Сообщения старше этого возраста отбрасываются. Twitch рекомендует не больше
 * десяти минут: подпись остаётся валидной вечно, поэтому без проверки времени
 * перехваченный запрос можно переиграть когда угодно.
 */
export const maxMessageAgeMs = 10 * 60 * 1000;

export type VerifyFailureReason =
  | "missing_headers"
  | "bad_timestamp"
  | "stale"
  | "bad_signature";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

export type VerifyInput = {
  messageId: string | null;
  timestamp: string | null;
  signature: string | null;
  /** Тело строго в исходном виде: пересобранный JSON даст другую подпись. */
  body: string;
  secret: string;
  now?: Date;
};

export function verifyEventSubSignature(input: VerifyInput): VerifyResult {
  const { messageId, timestamp, signature, body, secret } = input;

  if (!messageId || !timestamp || !signature) {
    return { ok: false, reason: "missing_headers" };
  }

  const sentAt = Date.parse(timestamp);
  if (Number.isNaN(sentAt)) return { ok: false, reason: "bad_timestamp" };

  const now = input.now?.getTime() ?? Date.now();
  if (Math.abs(now - sentAt) > maxMessageAgeMs) {
    return { ok: false, reason: "stale" };
  }

  const expected = `sha256=${createHmac("sha256", secret)
    .update(messageId + timestamp + body)
    .digest("hex")}`;

  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);

  // timingSafeEqual падает на разной длине, поэтому длину сверяем заранее —
  // сама по себе она секрета не раскрывает.
  if (actualBytes.length !== expectedBytes.length) {
    return { ok: false, reason: "bad_signature" };
  }

  return timingSafeEqual(actualBytes, expectedBytes)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

/** Подпись сообщения тем же способом, что и Twitch. Нужна тестам и отладке. */
export function signEventSubMessage(params: {
  messageId: string;
  timestamp: string;
  body: string;
  secret: string;
}): string {
  return `sha256=${createHmac("sha256", params.secret)
    .update(params.messageId + params.timestamp + params.body)
    .digest("hex")}`;
}
