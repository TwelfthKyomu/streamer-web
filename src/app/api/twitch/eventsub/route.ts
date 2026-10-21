import { env } from "@/core/env";
import { logger } from "@/core/logger";
import {
  handleNotification,
  twitchHeaders,
  verifyEventSubSignature,
} from "@/modules/twitch";

// Вебхук обязан считать тело сам, поэтому статикой он быть не может.
export const dynamic = "force-dynamic";

type EventSubBody = {
  challenge?: unknown;
  subscription?: { type?: unknown; status?: unknown };
  event?: unknown;
};

function parseBody(raw: string): EventSubBody | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as EventSubBody)
      : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  // Именно текст, а не request.json(): подпись считается по исходным байтам,
  // и любой пересобранный JSON её не пройдёт.
  const raw = await request.text();
  const headers = request.headers;

  const verified = verifyEventSubSignature({
    messageId: headers.get(twitchHeaders.messageId),
    timestamp: headers.get(twitchHeaders.timestamp),
    signature: headers.get(twitchHeaders.signature),
    body: raw,
    secret: env.TWITCH_EVENTSUB_SECRET,
  });

  if (!verified.ok) {
    logger.warn({ reason: verified.reason }, "вебхук Twitch отклонён");
    return new Response(null, { status: 403 });
  }

  const body = parseBody(raw);
  if (!body) return new Response(null, { status: 400 });

  const messageType = headers.get(twitchHeaders.messageType);

  // Подтверждение подписки: Twitch ждёт challenge обратно голым текстом.
  // Ответ в JSON или с лишними пробелами подписку не активирует.
  if (messageType === "webhook_callback_verification") {
    if (typeof body.challenge !== "string") {
      return new Response(null, { status: 400 });
    }

    logger.info("подтверждена подписка EventSub");
    return new Response(body.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (messageType === "revocation") {
    logger.warn(
      {
        type: body.subscription?.type,
        status: body.subscription?.status,
      },
      "Twitch отозвал подписку EventSub",
    );
    return new Response(null, { status: 204 });
  }

  if (messageType !== "notification") {
    logger.warn({ messageType }, "неизвестный тип сообщения EventSub");
    return new Response(null, { status: 204 });
  }

  const messageId = headers.get(twitchHeaders.messageId);
  const subscriptionType =
    typeof body.subscription?.type === "string"
      ? body.subscription.type
      : headers.get(twitchHeaders.subscriptionType);

  if (!messageId || !subscriptionType) {
    return new Response(null, { status: 400 });
  }

  try {
    await handleNotification({
      messageId,
      subscriptionType,
      event: body.event,
      payload: body,
    });
  } catch (error) {
    // 5xx заставит Twitch повторить доставку, и дедупликация по messageId
    // не даст обработать событие дважды.
    logger.error({ err: error, subscriptionType }, "ошибка обработки EventSub");
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
