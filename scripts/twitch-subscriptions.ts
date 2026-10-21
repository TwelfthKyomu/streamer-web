/**
 * Управление подписками EventSub.
 *
 *   npm run twitch:subs            — показать текущие
 *   npm run twitch:subs create     — оформить недостающие
 *   npm run twitch:subs delete-all — снять все
 *
 * Колбэк должен быть публичным HTTPS-адресом: Twitch не умеет стучаться на
 * localhost. Локально это туннель, адрес задаётся в TWITCH_EVENTSUB_CALLBACK_URL.
 */

import { getPrimaryStreamerId } from "@/modules/overlay";
import {
  callbackUrl,
  createSubscription,
  deleteSubscription,
  getAppToken,
  getBroadcasterId,
  listSubscriptions,
  watchedTypes,
} from "@/modules/twitch";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function resolveBroadcaster(): Promise<string> {
  const streamerUserId = await getPrimaryStreamerId();

  if (!streamerUserId) {
    throw new Error(
      "Не найден профиль с ролью admin. Зайди на сайт под стримером и выдай роль admin.",
    );
  }

  const broadcasterId = await getBroadcasterId(streamerUserId);

  if (!broadcasterId) {
    throw new Error(
      "У админа нет связки с Twitch. Перезайди через Twitch — связка создаётся при входе.",
    );
  }

  return broadcasterId;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "list";
  const token = await getAppToken();
  const existing = await listSubscriptions(token);

  if (command === "list") {
    out(`Колбэк: ${callbackUrl()}`);
    out(`Подписок: ${existing.length}`);

    for (const item of existing) {
      out(
        `  ${item.type.padEnd(16)} ${item.status.padEnd(22)} ${item.transport.callback ?? "—"}`,
      );
    }

    return;
  }

  if (command === "delete-all") {
    for (const item of existing) {
      await deleteSubscription(token, item.id);
      out(`удалена ${item.type} (${item.id})`);
    }

    out(`Готово, снято подписок: ${existing.length}`);
    return;
  }

  if (command === "create") {
    const broadcasterId = await resolveBroadcaster();
    const callback = callbackUrl();

    if (callback.startsWith("http://")) {
      throw new Error(
        `Twitch принимает только HTTPS-колбэк, а сейчас ${callback}. Подними туннель и задай TWITCH_EVENTSUB_CALLBACK_URL.`,
      );
    }

    out(`Канал: ${broadcasterId}`);
    out(`Колбэк: ${callback}`);

    for (const type of watchedTypes) {
      // Повторная подписка на тот же тип и канал вернёт ошибку конфликта,
      // поэтому уже оформленные пропускаем.
      const already = existing.some(
        (item) =>
          item.type === type &&
          item.condition.broadcaster_user_id === broadcasterId &&
          item.transport.callback === callback,
      );

      if (already) {
        out(`  ${type}: уже есть, пропускаем`);
        continue;
      }

      const created = await createSubscription({
        token,
        type,
        broadcasterUserId: broadcasterId,
      });

      out(`  ${type}: создана, статус ${created.status}`);
    }

    out(
      "Статус pending — это нормально: Twitch дёрнет колбэк и переведёт подписку в enabled.",
    );
    return;
  }

  throw new Error(`Неизвестная команда: ${command}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
